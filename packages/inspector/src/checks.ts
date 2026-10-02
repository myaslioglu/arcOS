/**
 * Check rules — when each answers "unknown" (a failed or missing read is never silently a "pass"):
 * - verified: the explorer didn't answer, or it answered without a record of this address (a 404)
 *   or without the field — only an explicit `is_verified: false` is the `fail`, since that finding
 *   tells a reader the deployer never published the source.
 * - ownership: owner()/getOwner() failed at the network level (a revert just means "try the next
 *   name"); or there's no owner function and the contract's logic code couldn't be read at all, so
 *   whether anyone controls it can't be told either way; or there's no owner function but the
 *   contract does have privileged functions (in logic code that WAS read), so who (if anyone) can
 *   call them can't be read; or owner() IS a burn address but the logic code couldn't be read, so
 *   role-based admins can't be ruled out. "Ownership is renounced" is reserved for a burn-address
 *   owner() on logic that WAS read and has no `grantRole`: with AccessControl in the code, a
 *   renounced Ownable leaves the roles untouched, so it's reported as role-based admin (a warn).
 * - privileges: the contract's logic code couldn't be read (see `LogicGap` — a clone, or an
 *   EIP-1967 or ZeppelinOS-style proxy, whose implementation is unreachable, points at empty code,
 *   is itself a proxy, or can't be picked out because its slots name two candidates); or
 *   privileged functions were found but the owner is unknown, or there's no owner function at all
 *   (can't tell if they're reachable either way). A proxy is always judged on its IMPLEMENTATION's
 *   bytecode and ABI, never on its own trampoline, which has no dispatcher and so would look
 *   privilege-free.
 * - proxy: the proxy slots are EIP-1967's and, read after them, the older ZeppelinOS ones that
 *   Circle's FiatToken proxies use; a ZeppelinOS-style proxy is judged exactly like an EIP-1967
 *   one. A storage-read failure on the top-level address propagates and is caught by the
 *   orchestrator's guard, so "Not a proxy" only ever rests on slots that were actually read; an
 *   EIP-1167 clone whose implementation couldn't be fetched at all (a transport failure) is
 *   unknown, never "not upgradeable"; a clone whose target read succeeded but came back with no
 *   code at all is a fail (it points at nothing); a resolved clone whose target is itself an
 *   upgradeable proxy is a fail ("Clone of an upgradeable proxy"), not a pass; a clone whose
 *   target's own proxy slots couldn't be read is unknown, because an unread slot is not an unset
 *   one; code that delegates calls (DELEGATECALL) but resolves to no known clone target or proxy
 *   slot is unknown, not "not a proxy".
 * - holders: the explorer didn't answer, total supply is unknown, or the holder list came back
 *   empty — which is never treated as "0% concentration" once total supply is known to be non-zero
 *   (a non-zero supply guarantees at least one holder exists), regardless of what the explorer's own
 *   holders-count field claims — or (with a DEX configured) pool discovery failed, so pools can't be
 *   excluded from the holder list; or the rows left after those exclusions are fewer than ten and
 *   the explorer confirms neither (through `next_page_params` nor through its own holders-count)
 *   that they are every holder there is, since a share added up from an unknown fraction of the
 *   holders is a floor, not a concentration figure — a floor can still be a warn or a fail, but
 *   never a pass.
 * - liquidity: no DEX is configured for this network, pool discovery failed at the network level,
 *   or every pool contract reverted (an address with no contract code does that, and inside a
 *   multicall answers 0x), which is never reported as "no pool found" — that would be a claim about
 *   pools made from a call that failed. The same goes for one family (Uniswap v2 and v3, Uniswap v4,
 *   Aerodrome) that never answered while another did: a liquid pool found elsewhere still passes, but
 *   "no pool" and "thin" wait for it. A v4 pool is liquid when a V4Quoter quote for 1,000 USDC out
 *   succeeds; the "in range" figure shown with it (see `quoteInRange`) decides nothing.
 * - lp-lock: no DEX is configured, pool discovery failed, the pool contracts never answered (or a
 *   family didn't and no pool was found), only pools other than Uniswap v2 exist (positions in v3, v4
 *   and Aerodrome pools can't be read without an index), or the v2 pair's LP totalSupply is zero (no
 *   evidence to compute a locked share from).
 * - prevrandao: the contract's logic code couldn't be read (the same `LogicGap` cases as
 *   privileges); a proxy's implementation bytecode is what gets scanned, never the trampoline's.
 *
 * On top of all of that, ownership, privileges and prevrandao are statements about code, so a
 * `pass` from any of them is conditional on the engine having seen the code that will actually run
 * — see `LogicBlock` and `gateLogicPass`. When the logic can be replaced (anything upgradeable), a
 * would-be pass becomes a `warn` naming who can replace it; when the scored code can run code from
 * elsewhere (DELEGATECALL), it becomes `unknown`. Their `fail`/`warn` findings describe the logic
 * running NOW and stand unchanged.
 */
import { parseAbi } from "viem";
import { BURN_ADDRESSES, USDC, type Address, type DexConfig } from "@arcos/chain";
import { usesOpcode } from "./bytecode";
import { SEVERE, type Privilege, type PrivilegeCategory } from "./privileges";
import type { ContractInfo, HolderPage } from "./explorer";
import { CallReverted, type ChainReader, type Finding, type InspectInput, type Pool, type PoolScan, type PoolVersion } from "./types";
import { multicall, type BatchCall, type BatchResult } from "./multicall";
import { NATIVE, readV4Pools, type V4Quote } from "./v4";

export const erc20Abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const ownableAbi = parseAbi(["function owner() view returns (address)", "function getOwner() view returns (address)"]);
const beaconAbi = parseAbi(["function implementation() view returns (address)"]);
const v2FactoryAbi = parseAbi(["function getPair(address,address) view returns (address)"]);
const v3FactoryAbi = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
/** Slipstream's factory keys a pool by tick spacing (an int24), where Uniswap v3's takes a fee. */
const aeroFactoryAbi = parseAbi(["function getPool(address,address,int24) view returns (address)"]);

const FORWARDS_TO_UNIDENTIFIED_TITLE = "Forwards calls to unidentified code";
const FORWARDS_TO_UNIDENTIFIED_DETAIL =
  "The code contains a DELEGATECALL, but no EIP-1167 clone target, EIP-1967 proxy slot or ZeppelinOS proxy slot could be resolved.";

/**
 * Why the engine has no logic code to score. A proxy's own bytecode is a trampoline with no
 * function dispatcher, so scoring it would read "nothing privileged here" off the proxy instead of
 * off the code that actually runs — every one of these is `unknown`, never a pass. `null` means the
 * logic code WAS read.
 */
export type LogicGap = "logic-unreadable" | "logic-empty" | "logic-unidentified" | "logic-ambiguous";

const LOGIC_GAP: Record<LogicGap, { title: string; detail: string }> = {
  "logic-unreadable": { title: "Couldn't read the contract's logic", detail: "This contract runs another contract's code, and that code couldn't be read." },
  "logic-empty": { title: "Couldn't read the contract's logic", detail: "This contract forwards its calls to an address that has no contract code at all, so there's no logic to read." },
  "logic-unidentified": { title: "Couldn't read the contract's logic", detail: "This contract's logic sits behind a further proxy, so the code that actually runs couldn't be identified." },
  "logic-ambiguous": { title: "Couldn't read the contract's logic", detail: "This proxy's slots name two different places its logic could live — both of EIP-1967's slots, or an EIP-1967 slot and the ZeppelinOS one — and only its own bytecode decides which it runs, so which code to read can't be told." },
};

const ZERO = "0x0000000000000000000000000000000000000000";
const GRANT_ROLE = "0x2f2ff15d";
const ERC20_TRANSFER = "0xa9059cbb";
const lower = (a: string) => a.toLowerCase();
const isBurn = (a: string) => BURN_ADDRESSES.some((b) => lower(b) === lower(a));

/** `0x1234…abcd`. The web app has its own copy in `apps/web/src/lib/format.ts`; this package is a
 * leaf that never imports from an app, and one line is cheaper than a shared dependency for it. */
const shortAddress = (a: string): string => (a.length <= 12 ? a : `${a.slice(0, 6)}…${a.slice(-4)}`);

/**
 * Why a would-be `pass` about what this contract's logic DOES can't stand, even though the check
 * found nothing wrong with the code it read.
 *
 * `mutable` (R1): the code can be replaced — this address's own proxy slots (EIP-1967's or
 * ZeppelinOS's) are set, or it is a clone of a contract whose are (exactly the condition
 * `checkProxy` fails on, read from the same value so the two can never disagree). "No privileged
 * functions", "Ownership is renounced", "No owner function" and "Doesn't rely on on-chain
 * randomness" are then statements about code that can be different tomorrow. They stay true of
 * the logic running NOW, which is why this downgrades to a `warn` naming who can replace it
 * rather than to an `unknown`.
 *
 * `delegatecall`: the code being scored can run code from another address, which this scan never
 * sees, so "nothing of the sort is in here" doesn't rule it out. Nothing is known about the code
 * that isn't visible, so this is `unknown`, and it outranks `mutable` — a UUPS implementation is
 * both, and "I can't see what it runs" is the stronger fact.
 *
 * `dispatcher` / `opcodes` (R2): the scan can't be shown to have read this contract at all — see
 * `dispatcherVisible`. `dispatcher` is the selector-scan form (a verified ABI declaring `transfer`
 * can stand in for the bytecode); `opcodes` is the form `prevrandao` uses, where only the bytecode
 * counts, because no ABI says anything about which instructions a contract contains. Both are
 * `unknown`, and both outrank `mutable` for the same reason.
 *
 * `forwards-unknown`: this address's own proxy slots couldn't be read, so whether the code being
 * scored is the code that runs was never established. It outranks everything: without that answer,
 * the rest is a reading of bytecode that may not be the bytecode in play.
 */
export type LogicBlock =
  | { kind: "forwards-unknown" }
  | { kind: "delegatecall" }
  | { kind: "dispatcher" }
  | { kind: "opcodes" }
  | { kind: "mutable"; admin: Address | null; proxy: Address; /** The current logic already exposes
      privileged functions (they just can't be called today), so an upgrade restores rather than
      adds. Only changes the wording. */ privileged: boolean };

/**
 * R2 — a scan is evidence of ABSENCE only if it can be shown to have seen this contract's
 * dispatcher. The thing being inspected is a token, so the test is ERC-20's own
 * `transfer(address,uint256)`: a scan that can't even see `transfer` has no standing to say whether
 * there is a `mint`. Vyper's dense dispatcher, Huff, a fallback-only contract and via-IR jump
 * tables all land here, as does `0x00`.
 */
export function dispatcherVisible(abi: readonly unknown[] | null, selectors: Set<string>): boolean {
  return dispatcherInBytecode(selectors) || abiDeclaresTransfer(abi);
}

/** The bytecode half: the dispatcher itself compares against the `transfer` selector. This is the
 * only half an OPCODE scan can use — an ABI describes functions and says nothing about what
 * instructions the contract contains. */
export function dispatcherInBytecode(selectors: Set<string>): boolean {
  return selectors.has(ERC20_TRANSFER);
}

/**
 * The explorer half: a published ABI that declares `transfer(address,uint256)` — the name AND the
 * argument types, mirroring exactly what the bytecode half matches. "Any non-empty ABI" was too
 * weak: a verified contract whose published ABI holds one unrelated function (or a stale, partial
 * one) would have stood as proof that the whole dispatcher had been read.
 */
export function abiDeclaresTransfer(abi: readonly unknown[] | null): boolean {
  if (abi === null) return false;
  return abi.some((raw) => {
    if (typeof raw !== "object" || raw === null) return false;
    const entry = raw as { type?: unknown; name?: unknown; inputs?: unknown };
    if (entry.type !== "function" || entry.name !== "transfer" || !Array.isArray(entry.inputs)) return false;
    const types = entry.inputs.map((i) => (typeof i === "object" && i !== null ? (i as { type?: unknown }).type : null));
    return types.length === 2 && types[0] === "address" && types[1] === "uint256";
  });
}

/**
 * Short on purpose: the OG card gives a row ONE line at font size 30, which is about 43 characters
 * — the address and the reasoning go in `detail`. Two sets, because "added" understates logic that
 * already HAS privileged functions today and is merely held back by a renounced owner: an upgrade
 * there restores what is already written.
 */
const MUTABLE_TITLE: Record<"clean" | "privileged", Partial<Record<Finding["id"], string>>> = {
  clean: {
    ownership: "Control can be added by an upgrade",
    privileges: "Privileges can be added by an upgrade",
    prevrandao: "Randomness can be added by an upgrade",
  },
  privileged: {
    ownership: "Control can be restored by an upgrade",
    privileges: "Privileges can be restored by an upgrade",
    prevrandao: "Randomness can be added by an upgrade",
  },
};

const OPAQUE_LOGIC: Record<"forwards-unknown" | "delegatecall" | "dispatcher" | "opcodes", { title: string; detail: string }> = {
  "forwards-unknown": {
    title: "Couldn't tell if this contract forwards",
    detail: "This contract's EIP-1967 and ZeppelinOS proxy slots couldn't be read, so whether the code scanned here is the code that actually runs was never established.",
  },
  delegatecall: {
    title: "Runs code this check can't see",
    detail: "This contract can run code from another address (DELEGATECALL), which this check can't see — so what it found here rules nothing out.",
  },
  dispatcher: {
    title: "Couldn't read this contract's functions",
    detail: "No ERC-20 transfer function could be found in this contract's bytecode, and no verified ABI declares one, so this scan can't claim to have seen what it does or doesn't expose.",
  },
  opcodes: {
    title: "Couldn't read this contract's code",
    detail: "This doesn't read as an ERC-20's bytecode — the transfer function isn't in it — so what an opcode scan finds, or doesn't find, in it says nothing. A published ABI can't answer this one: it describes functions, not instructions.",
  },
};

/**
 * Applies a `LogicBlock` to a finding one of the three logic checks already produced. Only a
 * `pass` is ever rewritten: a `fail` or `warn` describes the logic running now and is still true,
 * and an `unknown` is already the weakest thing this engine says.
 */
export function gateLogicPass(input: InspectInput, finding: Finding, block: LogicBlock | null): Finding {
  if (block === null || finding.status !== "pass") return finding;
  if (block.kind === "mutable") {
    // No "But" here: the detail it is appended to may already contain one ("Found mint(...), but
    // ownership is renounced"), and two of them in one paragraph read as a correction of a
    // correction.
    const who = block.admin ? `The proxy admin ${shortAddress(block.admin)}` : "Whoever controls upgrades";
    return {
      ...finding,
      status: "warn",
      title: MUTABLE_TITLE[block.privileged ? "privileged" : "clean"][finding.id] ?? "An upgrade can change this",
      detail: `${finding.detail} ${who} can replace this contract's code, so that only describes the logic running now.`,
      evidenceUrl: `${input.explorerBase}/address/${block.proxy}?tab=contract`,
    };
  }
  const { title, detail } = OPAQUE_LOGIC[block.kind];
  return { ...finding, status: "unknown", title, detail };
}

/** Rounds to at most one decimal and drops a trailing ".0" — "30%", "50.4%", never "50.0%". */
const formatPct = (pct: number): string => {
  const rounded = Math.round(pct * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
};

/** Swallows only `CallReverted` (the call reached the chain and said no); anything else propagates. */
async function catchReverted<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof CallReverted) return fallback;
    throw e;
  }
}

export type Owner =
  | { kind: "none" }
  | { kind: "renounced" }
  /** The logic exposes `grantRole`. `renounced` records that `owner()` is a burn address as well —
   * which says nothing about role holders, so it never reaches the "renounced" kind. */
  | { kind: "roles"; renounced: boolean }
  | { kind: "unknown" }
  | { kind: "wallet" | "contract"; address: Address };

export async function resolveOwner(reader: ChainReader, token: Address, selectors: Set<string>): Promise<Owner> {
  for (const fn of ["owner", "getOwner"]) {
    let owner: Address;
    try {
      owner = (await reader.read(token, ownableAbi, fn)) as Address;
    } catch (e) {
      if (e instanceof CallReverted) continue; // no such function — try the next name
      return { kind: "unknown" }; // a transport failure means nothing about ownership
    }
    // Renouncing Ownable retires owner-only functions; it does nothing to AccessControl, so a
    // contract with `grantRole` still has role holders who can call whatever the roles gate.
    if (isBurn(owner)) return selectors.has(GRANT_ROLE) ? { kind: "roles", renounced: true } : { kind: "renounced" };
    try {
      return { kind: (await reader.getCode(owner)) ? "contract" : "wallet", address: owner };
    } catch {
      return { kind: "unknown" };
    }
  }
  return selectors.has(GRANT_ROLE) ? { kind: "roles", renounced: false } : { kind: "none" };
}

/**
 * An EIP-1967 beacon proxy keeps its logic address behind `beacon.implementation()` (selector
 * 0x5c60da1b) rather than in a storage slot, so the beacon's own code is never the logic. Returns
 * null when the call reverts, the network doesn't answer, or the answer is the zero address —
 * "couldn't resolve it" is never evidence about what runs.
 */
export async function beaconImplementation(reader: ChainReader, beacon: Address | null): Promise<Address | null> {
  if (!beacon) return null;
  try {
    const impl = await reader.read(beacon, beaconAbi, "implementation");
    return typeof impl === "string" && lower(impl) !== ZERO ? (impl as Address) : null;
  } catch {
    return null;
  }
}

/** 1,000 units of a 6-decimal quote token: what a pool must hold, or on v4 must pay out to a quote, to count as liquid. */
const MIN_DEPTH = 1_000_000_000n;

/** Distinguishes "the factory reverted" from "the factory answered the zero address". */
const REVERTED = Symbol("factory call reverted");

const VENUE: Record<PoolVersion, string> = { v2: "Uniswap v2", v3: "Uniswap v3", v4: "Uniswap v4", aero: "Aerodrome" };

/** "a", "a and b", "a, b and c" (or "or"). */
const listWith = (word: "and" | "or", items: readonly string[]): string =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} ${word} ${items[items.length - 1]}`;

/** The Uniswap versions a config reads, in order. */
const uniswapVersions = (dex: DexConfig): ("v2" | "v3" | "v4")[] => [
  ...(dex.v2Factory ? ["v2" as const] : []),
  ...(dex.v3Factory ? ["v3" as const] : []),
  ...(dex.v4 ? ["v4" as const] : []),
];

/** The v2 and v3 factories are one family: they were always asked together and read as answered together. */
const uniswapV2V3Name = (dex: DexConfig): string => `Uniswap ${listWith("and", [dex.v2Factory && "v2", dex.v3Factory && "v3"].filter((v): v is string => Boolean(v)))}`;

/**
 * What can be quoted against: the config's quote tokens and, on v4, native USDC (currency `address(0)`, the same asset as the
 * USDC ERC-20 view, with 18 decimals). A token is never its own quote, so inspecting USDC leaves out both forms of it.
 */
function v4Quotes(dex: DexConfig, token: Address): V4Quote[] {
  const quotes = dex.quoteTokens.filter((q) => lower(q.address) !== lower(token)).map((q) => ({ ...q, decimals: 6 }));
  const native = dex.quoteTokens.some((q) => lower(q.address) === lower(USDC)) && lower(token) !== lower(USDC);
  return native ? [...quotes, { address: NATIVE, symbol: "USDC", decimals: 18 }] : quotes;
}

/** Rejects if any call fails at the transport level — the caller decides what "pools unknown" means. */
export async function findPools(input: InspectInput): Promise<PoolScan> {
  const { dex, reader, address } = input;
  if (!dex) return { pools: [], factoriesAnswered: false, silent: [] };
  let uniswapAnswered = false;
  const askFactory = async (factory: Address, abi: typeof v2FactoryAbi | typeof v3FactoryAbi, fn: string, args: unknown[]): Promise<unknown> => {
    const answer = await catchReverted<unknown>(reader.read(factory, abi, fn, args), REVERTED);
    if (answer === REVERTED) return null;
    uniswapAnswered = true;
    return answer;
  };
  const add = async (pool: unknown, version: PoolVersion, quote: { address: Address; symbol: string }): Promise<Pool | null> => {
    if (typeof pool !== "string" || lower(pool) === ZERO) return null;
    const depth = await catchReverted(reader.read(quote.address, erc20Abi, "balanceOf", [pool]) as Promise<bigint>, 0n);
    return { address: pool as Address, version, quote: quote.symbol, depth, liquid: depth >= MIN_DEPTH };
  };
  // Uniswap v2 and v3 exist on mainnet only, so a network's config may leave either out: nothing is asked of a factory it
  // doesn't name, and v3 without fee tiers has no pool to look for.
  const { v2Factory, v3Factory, aero: aeroConfig } = dex;
  const v3Tiers = v3Factory ? (dex.v3FeeTiers ?? []).map((fee) => ({ factory: v3Factory, fee })) : [];
  // A token is never its own quote: inspecting USDC or EURC skips that quote.
  const quotes = dex.quoteTokens.filter((quote) => lower(quote.address) !== lower(address));
  const perQuote = quotes.map(async (quote) => {
    const [v2Pool, v3Pools] = await Promise.all([
      v2Factory ? askFactory(v2Factory, v2FactoryAbi, "getPair", [address, quote.address]).then((pair) => add(pair, "v2", quote)) : null,
      Promise.all(
        v3Tiers.map(({ factory, fee }) =>
          askFactory(factory, v3FactoryAbi, "getPool", [address, quote.address, fee]).then((pool) => add(pool, "v3", quote)),
        ),
      ),
    ]);
    return [v2Pool, ...v3Pools];
  });
  const v4 = dex.v4
    ? readV4Pools({ reader, v4: dex.v4, token: address, quotes: v4Quotes(dex, address), extra: input.extraPools ?? [], quoteUnits: MIN_DEPTH / 1_000_000n })
    : null;

  // Aerodrome Slipstream: the factory's `getPool` for every quote and every tick spacing the config lists, in one multicall
  // (12 questions would otherwise be 12 parallel requests), then the quote balance of each pool that exists, as for v3.
  const aeroAsks = aeroConfig
    ? quotes.flatMap((quote) =>
        aeroConfig.tickSpacings.map((spacing) => ({
          quote,
          call: { target: aeroConfig.clFactory, abi: aeroFactoryAbi, functionName: "getPool", args: [address, quote.address, spacing] } satisfies BatchCall,
        })),
      )
    : [];
  const aero = (async (): Promise<{ answered: boolean; pools: (Pool | null)[] }> => {
    if (aeroAsks.length === 0) return { answered: false, pools: [] };
    let answers: BatchResult[];
    try {
      answers = await multicall(reader, aeroAsks.map((ask) => ask.call));
    } catch (e) {
      if (e instanceof CallReverted) return { answered: false, pools: [] }; // the aggregate itself reverted: nothing was read
      throw e;
    }
    const pools = await Promise.all(
      aeroAsks.map((ask, i) => {
        const answer = answers[i]!;
        return answer.ok ? add(answer.value, "aero", ask.quote) : null;
      }),
    );
    return { answered: answers.some((a) => a.ok), pools };
  })();
  const [uniswapResults, v4Read, aeroRead] = await Promise.all([Promise.all(perQuote), v4, aero]);

  // A family whose contracts never answered says nothing about its pools. The answer that matters to a finding is whether
  // one exists, so each configured family is accounted for on its own.
  const families = [
    { name: uniswapV2V3Name(dex), configured: Boolean(v2Factory || v3Factory), answered: uniswapAnswered },
    { name: VENUE.v4, configured: Boolean(dex.v4), answered: v4Read?.answered ?? false },
    { name: VENUE.aero, configured: Boolean(aeroConfig), answered: aeroRead.answered },
  ];
  return {
    pools: [
      ...uniswapResults.flat().filter((p): p is Pool => p !== null),
      ...aeroRead.pools.filter((p): p is Pool => p !== null),
      ...(v4Read?.pools ?? []),
    ],
    factoriesAnswered: families.some((f) => f.configured && f.answered),
    silent: families.filter((f) => f.configured && !f.answered).map((f) => f.name),
  };
}

const finding = (id: Finding["id"], status: Finding["status"], title: string, detail: string, extra: Partial<Finding> = {}): Finding => ({
  id, status, title, detail, evidenceUrl: null, fixAppId: null, ...extra,
});

/**
 * `contract` is `null` when the explorer couldn't be reached at all, and `contract.verified` is
 * `null` when it answered but has no record of this address (a 404) or didn't say either way.
 * Neither is "not verified": a `fail` here tells a reader the deployer never published the source,
 * so it has to rest on the explorer positively saying so.
 *
 * "Anyone can read what this contract does" is a claim about the code that RUNS, so for a proxy or
 * a clone it has to cover the implementation too. `logic` is `null` when this address runs its own
 * code, and otherwise says where the code that runs lives (`at`, `null` when the engine knows this
 * token forwards but couldn't identify where) and what the explorer has on it. A verified proxy in
 * front of unverified logic is the shape that made this matter: the reassuring line was true of 40
 * lines of forwarding code and false of everything behind it.
 */
export type LogicVerification = { at: Address | null; info: ContractInfo | null };

export function checkVerified(
  input: InspectInput,
  contract: ContractInfo | null,
  logic: LogicVerification | null = null,
  arcosTemplate: boolean | null = null,
): Finding {
  const url = `${input.explorerBase}/address/${input.address}?tab=contract`;
  // Positive evidence from chain, not the explorer: the 4rc.OS TokenFactory marks only the tokens it deploys itself,
  // each from one of its fixed templates, and the templates are published with the factory's verified source. It
  // never covers code that forwards its calls, and a failed read (null) claims nothing.
  if (arcosTemplate === true && logic === null && input.arcosTokenFactory && contract?.verified !== true) {
    return finding("verified", "pass", "Source code is verified (through the 4rc.OS TokenFactory)", "The 4rc.OS TokenFactory created this token, and it can only deploy four fixed templates, whose source is part of its verified source. This address's own explorer page may still say it isn't verified.", { evidenceUrl: `${input.explorerBase}/address/${input.arcosTokenFactory}?tab=contract` });
  }
  if (contract === null) return finding("verified", "unknown", "Couldn't check source verification", "The explorer didn't answer.", { evidenceUrl: url });
  if (contract.verified === null) return finding("verified", "unknown", "Couldn't check source verification", "The explorer has no record of this contract yet.", { evidenceUrl: url });
  if (!contract.verified) return finding("verified", "fail", "Source code isn't verified", "Only bytecode is public, so its behaviour can't be read directly.", { evidenceUrl: url });
  if (logic === null) return finding("verified", "pass", "Source code is verified", "Anyone can read what this contract does.", { evidenceUrl: url });
  if (logic.at === null) {
    return finding("verified", "unknown", "Couldn't check source verification", "This address's own source is verified, but it forwards its calls to code that couldn't be identified — so what it actually runs may be anything.", { evidenceUrl: url });
  }
  const logicUrl = `${input.explorerBase}/address/${logic.at}?tab=contract`;
  if (logic.info === null || logic.info.verified === null) {
    return finding("verified", "unknown", "Couldn't check source verification", `This proxy's own source is verified, but whether ${logic.at} — the implementation it runs — is verified couldn't be checked.`, { evidenceUrl: logicUrl });
  }
  return logic.info.verified
    ? finding("verified", "pass", "Source code is verified", `Both this proxy and the implementation it runs (${logic.at}) are verified.`, { evidenceUrl: url })
    : finding("verified", "fail", "The code this proxy runs isn't verified", `The proxy's own source is verified, but the implementation it runs (${logic.at}) isn't — only its bytecode is public.`, { evidenceUrl: logicUrl });
}

/**
 * `found` is the union of ABI- and bytecode-derived privileges (see `combinePrivileges`), already
 * resolved by the caller — `null` when the contract's logic code couldn't be read at all (an
 * unfetchable clone target, or a DELEGATECALL to unidentified code). `found === null` must NOT be
 * treated the same as "logic read, nothing privileged found": when there's no owner() function and
 * the logic is unreadable, whether anyone controls the contract can't be told either way.
 */
export function checkOwnership(input: InspectInput, owner: Owner, found: Privilege[] | null): Finding {
  const url = `${input.explorerBase}/address/${input.address}?tab=read_contract`;
  if (owner.kind === "unknown") return finding("ownership", "unknown", "Couldn't read the owner", "The network didn't answer the owner() call.", { evidenceUrl: url });
  if (owner.kind === "renounced") {
    // A burn-address owner() is only half the story: role-based admins live in the logic, and
    // `resolveOwner` can only rule them out from selectors it actually read. With no logic to
    // read, "nobody controls this" is a bigger claim than the evidence supports.
    return found === null
      ? finding("ownership", "unknown", "Couldn't read the contract's logic", "owner() is a burn address, but the contract's logic code couldn't be read, so whether anything else (a role, an admin) can still control it can't be told.", { evidenceUrl: url })
      : finding("ownership", "pass", "Ownership is renounced", "owner() is a burn address.", { evidenceUrl: url });
  }
  if (owner.kind === "none") {
    if (found === null) {
      return finding("ownership", "unknown", "Couldn't read the contract's logic", "The contract's logic code couldn't be read, so it can't tell whether anyone controls it.", { evidenceUrl: url });
    }
    return found.length > 0
      ? finding("ownership", "unknown", "No owner function, but privileges exist", "The contract exposes no owner() or getOwner(), but its code has privileged functions — who (if anyone) can call them can't be read.", { evidenceUrl: url })
      : finding("ownership", "pass", "No owner function", "The contract exposes no owner() or getOwner().", { evidenceUrl: url });
  }
  if (owner.kind === "roles") {
    const detail = owner.renounced
      ? "owner() is a burn address, so ownership is renounced — but the contract also uses AccessControl, and giving up Ownable revokes no roles. Role holders can't be listed from bytecode."
      : "Uses AccessControl; role holders can't be listed from bytecode.";
    return finding("ownership", "warn", "Role-based admin", detail, { evidenceUrl: url });
  }
  const ownerUrl = `${input.explorerBase}/address/${owner.address}`;
  return owner.kind === "wallet"
    ? finding("ownership", "warn", "Owned by a wallet", `${owner.address} controls owner-only functions.`, { evidenceUrl: ownerUrl })
    : finding("ownership", "warn", "Owned by a contract", `${owner.address} (a multisig, timelock or other contract) controls owner-only functions.`, { evidenceUrl: ownerUrl });
}

const PRIVILEGE_TITLE: Record<PrivilegeCategory, string> = {
  mint: "Owner can mint new supply",
  blacklist: "Owner can block wallets from trading",
  fees: "Owner can change transfer fees",
  limits: "Owner can change transaction limits",
  pause: "Owner can switch trading on or off",
};

/**
 * `found` is the union of ABI- and bytecode-derived privileges (see `combinePrivileges`),
 * already resolved by the caller — `null` when the logic code couldn't be read at all.
 */
export function checkPrivileges(input: InspectInput, found: Privilege[] | null, gap: LogicGap | null, owner: Owner): Finding {
  const url = `${input.explorerBase}/address/${input.address}?tab=write_contract`;
  if (found === null) {
    const { title, detail } = LOGIC_GAP[gap ?? "logic-unreadable"];
    return finding("privileges", "unknown", title, detail, { evidenceUrl: url });
  }
  const list = found.map((p) => p.signature).join(", ");
  if (found.length === 0) return finding("privileges", "pass", "No privileged functions found", "No mint, blacklist, fee, limit or pause function in the dispatcher.", { evidenceUrl: url });
  if (owner.kind === "unknown") {
    return finding("privileges", "unknown", "Privileged functions found, owner unknown", `Found: ${list}.`, { evidenceUrl: url });
  }
  if (owner.kind === "renounced") {
    return finding("privileges", "pass", "Privileged functions can't be called", `Found ${list}, but ownership is renounced.`, { evidenceUrl: url });
  }
  if (owner.kind === "none") {
    return finding("privileges", "unknown", "Privileged functions, no owner function", `Found: ${list}.`, { evidenceUrl: url });
  }
  const worst = found.find((p) => SEVERE.includes(p.category)) ?? found[0]!;
  const status = SEVERE.includes(worst.category) ? "fail" : "warn";
  return finding("privileges", status, PRIVILEGE_TITLE[worst.category], `Found: ${list}.`, { evidenceUrl: url });
}

export const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
/** EIP-1967 admin slot: who may call `upgradeToAndCall` on a transparent proxy. Empty on a UUPS
 * proxy (the right lives in the implementation) and on a beacon proxy (it lives on the beacon). */
export const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
/**
 * The slots proxies used before EIP-1967, from ZeppelinOS: `keccak256("org.zeppelinos.proxy.implementation")` and
 * `keccak256("org.zeppelinos.proxy.admin")`. Circle's FiatToken proxies, EURC on Arc among them, still keep their
 * implementation and admin there. They are read exactly like the EIP-1967 slots, and after them.
 */
export const ZEPPELINOS_IMPL_SLOT = "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3";
export const ZEPPELINOS_ADMIN_SLOT = "0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b";
/** Whose layout a proxy's slots follow: EIP-1967's, or ZeppelinOS's older one. */
export type ProxySlotKind = "eip1967" | "zeppelinos";
/**
 * An answer this engine can use at all: `null` or a bare `0x` (nodes answer a never-written slot
 * either way, and both mean "nothing in it"), or a full 32-byte word. Anything else — a truncated
 * value, a bare 20-byte address — is a malformed answer. It is not evidence that the slot is set,
 * and it is certainly not an address to read out of: taking the last 40 characters of `0x01` once
 * printed a proxy admin of "0x0x01". Callers treat it the same way they treat a read that threw.
 */
export const slotReadable = (v: string | null): boolean => v === null || v === "0x" || v.length === 66;
/** A slot that was read AND holds something. A malformed answer is neither set nor unset. */
export const slotSet = (v: string | null) => v !== null && v.length === 66 && /[1-9a-f]/i.test(v.slice(2));
/** The 20-byte address a 32-byte storage slot value points at, or null when the slot isn't set. */
export const addressFromSlot = (v: string | null): Address | null => (slotSet(v) ? (`0x${v!.slice(-40)}` as Address) : null);

export type ProxyResolution = {
  cloneOf: Address | null;
  /** Only meaningful when `cloneOf` is set: the clone's implementation code couldn't be fetched at
   * all — a transport failure, not evidence of anything. Never a pass. */
  cloneReadFailed: boolean;
  /** Only meaningful when `cloneOf` is set and `cloneReadFailed` is false: the read succeeded but
   * the target address has no code (`0x`) — a clone pointing at nothing, which is broken. */
  cloneTargetEmpty: boolean;
  /** Only meaningful when `cloneOf` is set: every one of the target's proxy slot reads (EIP-1967's
   * and ZeppelinOS's) answered. When they didn't, `upgradeable === false` means "not read", not
   * "not set", so the clone can't be called non-upgradeable. */
  targetSlotsRead: boolean;
  /** DELEGATECALL is present but resolves to no known clone target or proxy slot. */
  forwardsToUnidentifiedCode: boolean;
  /** The code finally scored as this token's logic contains a DELEGATECALL of its own. A clone is
   * not re-pointable, but "its logic can't be replaced" is a claim about the code that ends up
   * running, and whoever controls the address behind that DELEGATECALL controls exactly that. */
  logicDelegates: boolean;
  /** The code this token runs can be replaced: one of its own proxy slots (EIP-1967's implementation
   * or beacon slot, or ZeppelinOS's implementation slot) is set, or it is a clone of a contract
   * whose is. THE value — `checkProxy`'s upgradeability `fail` and R1's block on the logic checks
   * (`LogicBlock`) both read this one field, so the report can never say "upgradeable proxy" and
   * "ownership is renounced" side by side. */
  upgradeable: boolean;
  /** Whose layout the slots that make this upgradeable follow (EIP-1967 wins when both kinds are
   * set). It decides which admin slot `admin` was read from, and the wording. `null` when this
   * isn't upgradeable. */
  slotKind: ProxySlotKind | null;
  /** The admin slot (EIP-1967's, or ZeppelinOS's for a ZeppelinOS-style proxy) of whichever address
   * makes this upgradeable, when it holds one. `null` covers: not upgradeable, slot empty (UUPS or
   * beacon), slot unreadable, and both kinds of admin slot set to different accounts (or the
   * ZeppelinOS one unreadable) — they produce the same finding text ("whoever controls upgrades"),
   * because the one thing that must never be said is a name that wasn't read, or might not count. */
  admin: Address | null;
};

/** The wording for each kind of upgradeable proxy. EIP-1967's is the one this check always had. */
const UPGRADEABLE: Record<ProxySlotKind, { kind: string; title: string; admin: (admin: Address) => string; noAdmin: string }> = {
  eip1967: {
    kind: "an EIP-1967",
    title: "Upgradeable proxy",
    admin: (admin) => `${admin} holds the EIP-1967 admin slot and can replace this contract's logic.`,
    noAdmin: "Whoever controls the proxy admin can replace this contract's logic.",
  },
  zeppelinos: {
    kind: "a ZeppelinOS-style",
    title: "Upgradeable ZeppelinOS-style proxy",
    admin: (admin) => `${admin} holds the admin slot of this ZeppelinOS-style proxy and can replace this contract's logic.`,
    noAdmin: "Whoever controls this ZeppelinOS-style proxy's admin can replace this contract's logic.",
  },
};

export function checkProxy(input: InspectInput, r: ProxyResolution): Finding {
  const url = `${input.explorerBase}/address/${input.address}?tab=contract`;
  if (r.cloneOf) {
    const targetUrl = `${input.explorerBase}/address/${r.cloneOf}`;
    if (r.cloneReadFailed) {
      return finding("proxy", "unknown", "Couldn't check if this clone is upgradeable", `This is an EIP-1167 clone that forwards to ${r.cloneOf}, whose code couldn't be read.`, { evidenceUrl: targetUrl });
    }
    if (r.cloneTargetEmpty) {
      return finding("proxy", "fail", "Clone points at an address with no code", `An EIP-1167 clone of ${r.cloneOf}, which has no contract code at all — calls to it will fail.`, { evidenceUrl: targetUrl });
    }
    if (r.upgradeable) {
      const who = r.admin ? `whose admin ${r.admin} ` : "whoever controls it ";
      const { kind } = UPGRADEABLE[r.slotKind ?? "eip1967"];
      return finding("proxy", "fail", "Clone of an upgradeable proxy", `An EIP-1167 clone of ${r.cloneOf}, which is itself ${kind} upgradeable proxy — ${who}can replace what this token's logic actually delegates to.`, { evidenceUrl: targetUrl });
    }
    if (!r.targetSlotsRead) {
      return finding("proxy", "unknown", "Couldn't check if this clone is upgradeable", `This is an EIP-1167 clone of ${r.cloneOf}, whose own EIP-1967 and ZeppelinOS proxy slots couldn't be read.`, { evidenceUrl: targetUrl });
    }
    if (r.logicDelegates) {
      return finding("proxy", "unknown", "Couldn't check if this clone is upgradeable", `This is an EIP-1167 clone of ${r.cloneOf}, which can't be re-pointed — but the code it runs delegates calls to an address this check couldn't identify, and whoever controls that address controls what this token does.`, { evidenceUrl: targetUrl });
    }
    return finding("proxy", "pass", "Minimal proxy — not upgradeable", `An EIP-1167 clone of ${r.cloneOf}; its logic can't be replaced.`, { evidenceUrl: targetUrl });
  }
  if (r.forwardsToUnidentifiedCode) {
    return finding("proxy", "unknown", FORWARDS_TO_UNIDENTIFIED_TITLE, FORWARDS_TO_UNIDENTIFIED_DETAIL, { evidenceUrl: url });
  }
  if (r.upgradeable) {
    // Naming the admin is the difference between "someone could" and "this account can".
    const words = UPGRADEABLE[r.slotKind ?? "eip1967"];
    const title = r.admin ? `Upgradeable — admin ${shortAddress(r.admin)}` : words.title;
    const detail = r.admin ? words.admin(r.admin) : words.noAdmin;
    return finding("proxy", "fail", title, detail, { evidenceUrl: url });
  }
  return finding("proxy", "pass", "Not a proxy", "No EIP-1967 or ZeppelinOS proxy slots are set and the code doesn't delegate calls.", { evidenceUrl: url });
}

/**
 * A top-holder list looks identical whether it is every holder or the first page of thousands, so
 * completeness has to come from the explorer: `page.complete` (it said there is no next page) or
 * `holdersCount`, its own count of every holder of this token (`holders_count`). "The top 3 of
 * 5,000 holders hold 24%" is not a concentration figure.
 */
export function checkHolders(
  input: InspectInput,
  page: HolderPage | null,
  totalSupply: bigint | null,
  scan: PoolScan | null,
  holdersCount: number | null,
): Finding {
  const url = `${input.explorerBase}/token/${input.address}?tab=holders`;
  if (page === null || !totalSupply) return finding("holders", "unknown", "Couldn't check holder concentration", "The explorer didn't answer, or total supply is unknown.", { evidenceUrl: url });
  const holders = page.holders;
  // totalSupply > 0 (just checked above) guarantees at least one holder exists, so an empty list
  // here is never "0% concentration" — it's the explorer not having indexed this token yet. This
  // holds regardless of what the explorer's own holders-count field claims: a non-zero supply next
  // to a claimed holder count of 0 is itself a contradiction, not confirmation of "no holders".
  if (holders.length === 0) {
    return finding("holders", "unknown", "Couldn't check holder concentration", "The explorer returned no holders for a token with non-zero supply, which usually means it hasn't indexed this token yet.", { evidenceUrl: url });
  }
  if (scan === null && input.dex) {
    return finding("holders", "unknown", "Couldn't check holder concentration", "The pool lookup failed, so a liquidity pool could be miscounted as a whale.", { evidenceUrl: url });
  }
  // Two ways the explorer can confirm the rows in hand are every holder there is: it sent
  // `next_page_params: null` (this page is the last one), or its own holder count is no bigger
  // than the number of rows it sent. Without one of them this is one page of a longer list.
  const listComplete = page.complete || (holdersCount !== null && holdersCount <= holders.length);
  // Fewer than ten rows is only a complete picture when the explorer positively says that's
  // everyone. Otherwise the share they add up to is a floor, not a measurement — a share computed
  // from an unknown fraction of the holders is never a pass.
  if (holders.length < 10 && !listComplete) {
    return finding("holders", "unknown", "Couldn't check holder concentration", `The explorer returned ${holders.length} holder(s) but doesn't confirm that's all of them, so this would only be part of the concentration.`, { evidenceUrl: url });
  }
  const knownPools = scan?.pools ?? [];
  // Uniswap v4 keeps the tokens of every pool in one contract, the PoolManager: it is a pool whether or not discovery found
  // a pool of this token there (a hooked pool nobody has listed yet holds tokens too), and never a wallet.
  const poolManager = input.dex?.v4 ? [lower(input.dex.v4.poolManager)] : [];
  const skip = new Set([lower(input.address), ...knownPools.map((p) => lower(p.address)), ...input.knownLockers.map(lower), ...poolManager]);
  const ranked = [...holders].sort((a, b) => (a.value < b.value ? 1 : a.value > b.value ? -1 : 0));
  const top = ranked.filter((h) => !isBurn(h.address) && !skip.has(lower(h.address))).slice(0, 10);
  const held = top.reduce((sum, h) => sum + h.value, 0n);
  const pct = Number((held * 10000n) / totalSupply) / 100;
  const detail = "Excludes burn addresses, liquidity pools and known lock contracts.";
  // Excluding pools, burn addresses and the token itself can leave a full page with fewer than ten
  // wallets to add up. Calling those "all N wallets" is a claim about the whole holder list that
  // this page can't support, and the figure is a floor: more holders can only push it up. A floor
  // is still evidence for "at least this concentrated", so it can cross into warn or fail — it
  // just can never be the evidence for a pass.
  if (top.length < 10 && !listComplete) {
    const who = top.length === 1 ? "The top wallet holds" : `The top ${top.length} wallets hold`;
    const title = `${who} at least ${formatPct(pct)}`;
    if (pct > 50) return finding("holders", "fail", title, detail, { evidenceUrl: url, fixAppId: "vesting" });
    if (pct > 25) return finding("holders", "warn", title, detail, { evidenceUrl: url });
    return finding("holders", "unknown", "Couldn't check holder concentration", `Excluding pools, burn addresses and lock contracts left ${top.length} of the ${holders.length} rows the explorer sent, and it doesn't confirm those are all the holders — so ${formatPct(pct)} is a floor, not the concentration.`, { evidenceUrl: url });
  }
  // Say how many wallets the figure actually covers: "Top 10" on a token with three holders is a
  // claim about seven wallets that don't exist.
  const title =
    top.length >= 10 ? `Top 10 wallets hold ${formatPct(pct)}`
    : top.length === 0 ? "No wallet holds any of the supply"
    : top.length === 1 ? `The only wallet holds ${formatPct(pct)}`
    : `All ${top.length} wallets hold ${formatPct(pct)}`;
  if (pct > 50) return finding("holders", "fail", title, detail, { evidenceUrl: url, fixAppId: "vesting" });
  if (pct > 25) return finding("holders", "warn", title, detail, { evidenceUrl: url });
  return finding("holders", "pass", title, detail, { evidenceUrl: url });
}

const FACTORIES_SILENT =
  "Every call to the configured DEX contracts reverted, so no pool was found or ruled out — an address may hold no contract on this network.";

/** What was looked at, named from the config so that the finding is true of exactly the pools that were scanned. */
function noPoolFinding(dex: DexConfig): Finding {
  const uniswap = uniswapVersions(dex);
  const title = dex.aero
    ? `No ${uniswap.length > 0 ? "Uniswap or Aerodrome" : "Aerodrome"} pool found`
    : `No Uniswap ${listWith("or", uniswap)} pool found`;
  const venues = [...uniswap.map((v) => VENUE[v]), ...(dex.aero ? [VENUE.aero] : [])];
  const v4Caveat = dex.v4
    ? " Uniswap v4 pools are found by their standard hookless pool keys, so one with a hook or an unusual fee can be missed until an index lists it."
    : "";
  return finding("liquidity", "warn", title, `Looked at ${listWith("and", venues)} pools against ${listWith("and", dex.quoteTokens.map((q) => q.symbol))}.${v4Caveat}`);
}

/** What to say while a family of pool contracts never answered; null when every one did. */
const silentNote = (scan: PoolScan): string | null =>
  scan.silent.length > 0 ? `${listWith("and", scan.silent)} didn't answer, so a pool there can't be ruled out.` : null;

/** The kinds of pool a scan found, by name, in the order v2, v3, v4, Aerodrome. */
const foundVenues = (pools: readonly Pool[]): string[] =>
  (["v2", "v3", "v4", "aero"] as const).filter((v) => pools.some((p) => p.version === v)).map((v) => VENUE[v]);

/** The pool a finding is about: a liquid one, then an undecided one, then one that can't pay; the deepest within each. */
const rank = (p: Pool): number => (p.liquid === true ? 2 : p.liquid === null ? 1 : 0);
const bestPool = (pools: Pool[]): Pool => pools.reduce((a, b) => (rank(a) !== rank(b) ? (rank(b) > rank(a) ? b : a) : b.depth > a.depth ? b : a));

const wholeUnits = (depth: bigint): string => (depth / 1_000_000n).toLocaleString("en-US");
/** "1,000": the amount the copy says a liquid pool can pay out, from the one constant that decides it. */
const MIN_UNITS = wholeUnits(MIN_DEPTH);

export function checkLiquidity(input: InspectInput, scan: PoolScan | null): Finding {
  const { dex } = input;
  if (!dex) return finding("liquidity", "unknown", "Liquidity isn't checked on this network", "No DEX registry is configured here.");
  if (scan === null) return finding("liquidity", "unknown", "Couldn't read liquidity pools", "The network didn't answer the pool lookup.");
  if (!scan.factoriesAnswered) return finding("liquidity", "unknown", "Couldn't read liquidity pools", FACTORIES_SILENT);
  const pools = scan.pools;
  // A family that never answered can't be ruled out, so "no pool" and "thin" wait for it. A liquid pool found elsewhere doesn't.
  const silent = silentNote(scan);
  if (pools.length === 0) return silent ? finding("liquidity", "unknown", "Couldn't read liquidity pools", silent) : noPoolFinding(dex);
  const best = bestPool(pools);
  const units = wholeUnits(best.depth);
  const url = `${input.explorerBase}/address/${best.address}`;
  if (best.liquid === true) {
    return best.version === "v4"
      ? finding(
          "liquidity", "pass", `${MIN_UNITS} ${best.quote} can be swapped out of Uniswap v4`,
          `The v4 quoter can pay out ${MIN_UNITS} ${best.quote} from this pool. ${units} ${best.quote} in range at the current price; liquidity outside the current tick range isn't counted. ${pools.length} pool(s) found.`,
          { evidenceUrl: url },
        )
      : finding("liquidity", "pass", `${units} ${best.quote} of liquidity on ${VENUE[best.version]}`, `${pools.length} pool(s) found.`, { evidenceUrl: url });
  }
  // A quote that couldn't decide is no evidence of "thin", and with nothing liquid, none of "liquid" either.
  const undecided = pools.filter((p) => p.liquid === null);
  if (undecided.length > 0) {
    const why = [`The v4 quoter didn't answer for a Uniswap v4 pool, so it can't be called liquid or thin.`, silent].filter((x): x is string => x !== null);
    return finding("liquidity", "unknown", "Couldn't verify Uniswap v4 liquidity", why.join(" "), { evidenceUrl: `${input.explorerBase}/address/${undecided[0]!.address}` });
  }
  const deepest =
    best.version === "v4"
      ? `Deepest pool has ${units} ${best.quote} in range, and a ${MIN_UNITS} ${best.quote} swap can't be quoted.`
      : `Deepest pool holds ${units} ${best.quote}.`;
  return silent
    ? finding("liquidity", "unknown", "Couldn't read liquidity pools", `${silent} ${deepest}`, { evidenceUrl: url })
    : finding("liquidity", "warn", "Thin liquidity", deepest, { evidenceUrl: url });
}

export async function checkLpLock(input: InspectInput, scan: PoolScan | null): Promise<Finding> {
  if (!input.dex) return finding("lp-lock", "unknown", "Locks aren't checked on this network", "No DEX registry is configured here.");
  if (scan === null) return finding("lp-lock", "unknown", "Couldn't read liquidity pools", "The network didn't answer the pool lookup.");
  const v2 = scan.pools.filter((p) => p.version === "v2");
  if (v2.length === 0) {
    // Only v2 has LP tokens to count. Positions in v3, v4 and Aerodrome pools are NFTs or entries in the PoolManager, and
    // reading who holds them needs an index.
    const why = !scan.factoriesAnswered
      ? FACTORIES_SILENT
      : scan.pools.length === 0
        ? (silentNote(scan) ?? "No pool was found.")
        : `Only ${listWith("and", foundVenues(scan.pools))} pools were found, and liquidity positions in them can't be read without an index yet.`;
    // A "fix" button doesn't belong on something we couldn't check.
    return finding("lp-lock", "unknown", "Couldn't check liquidity locks", why, { fixAppId: null });
  }
  const pair = v2.reduce((a, b) => (b.depth > a.depth ? b : a));
  const read = (fn: string, args: unknown[] = []) => input.reader.read(pair.address, erc20Abi, fn, args) as Promise<bigint>;
  const supply = await read("totalSupply");
  const url = `${input.explorerBase}/token/${pair.address}?tab=holders`;
  if (supply === 0n) {
    // No evidence to compute a locked share from — an LP token with 0 supply isn't a "fail".
    return finding("lp-lock", "unknown", "Couldn't check liquidity locks", "The v2 LP token's totalSupply is 0.", { fixAppId: null });
  }
  const safe = [...BURN_ADDRESSES, ...input.knownLockers];
  const balances = await Promise.all(safe.map((a) => catchReverted(read("balanceOf", [a]), 0n)));
  const locked = balances.reduce((s, b) => s + b, 0n);
  const pct = Number((locked * 10000n) / supply) / 100;
  return pct >= 95
    ? finding("lp-lock", "pass", "Liquidity is burned or locked", `${formatPct(pct)} of the v2 LP supply can't be withdrawn.`, { evidenceUrl: url })
    : finding("lp-lock", "fail", "Liquidity isn't locked", `${formatPct(100 - pct)} of the v2 LP supply sits in wallets that can withdraw it.`, { evidenceUrl: url, fixAppId: "vault" });
}

export function checkPrevrandao(input: InspectInput, logicCode: string | null, gap: LogicGap | null): Finding {
  if (logicCode === null) {
    const { title, detail } = LOGIC_GAP[gap ?? "logic-unreadable"];
    return finding("prevrandao", "unknown", title, detail);
  }
  return usesOpcode(logicCode, 0x44)
    ? finding("prevrandao", "warn", "Uses PREVRANDAO, which is always 0 on Arc", "Any randomness derived from it is predictable.", { evidenceUrl: "https://docs.arc.io/arc/references/evm-differences" })
    : finding("prevrandao", "pass", "Doesn't rely on on-chain randomness", "The PREVRANDAO opcode isn't used.");
}
