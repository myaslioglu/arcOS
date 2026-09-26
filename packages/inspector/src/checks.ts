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
 * - privileges: the contract's logic code couldn't be read (see `LogicGap` — a clone or an
 *   EIP-1967 proxy whose implementation is unreachable, points at empty code, is itself a proxy, or
 *   can't be picked out because both proxy slots are set); or privileged functions were found but
 *   the owner is unknown, or there's no owner function at all (can't tell if they're reachable
 *   either way). A proxy is always judged on its IMPLEMENTATION's bytecode and ABI, never on its
 *   own trampoline, which has no dispatcher and so would look privilege-free.
 * - proxy: a storage-read failure on the top-level address propagates and is caught by the
 *   orchestrator's guard, so "Not a proxy" only ever rests on slots that were actually read; an
 *   EIP-1167 clone whose implementation couldn't be fetched at all (a transport failure) is
 *   unknown, never "not upgradeable"; a clone whose target read succeeded but came back with no
 *   code at all is a fail (it points at nothing); a resolved clone whose target is itself an
 *   EIP-1967 proxy is a fail ("Clone of an upgradeable proxy"), not a pass; a clone whose target's
 *   own EIP-1967 slots couldn't be read is unknown, because an unread slot is not an unset one;
 *   code that delegates calls (DELEGATECALL) but resolves to no known clone target or EIP-1967 slot
 *   is unknown, not "not a proxy".
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
 *   or every factory call reverted (an address with no contract code does that), which is never
 *   reported as "no pool found" — that would be a claim about pools made from a call that failed.
 * - lp-lock: no DEX is configured, pool discovery failed, the factories never answered, only
 *   Uniswap v3 pools exist (position locks need an indexer, which arrives with Radar), or the v2
 *   pair's LP totalSupply is zero (no evidence to compute a locked share from).
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
import { BURN_ADDRESSES, type Address } from "@arcos/chain";
import { usesOpcode } from "./bytecode";
import { SEVERE, type Privilege, type PrivilegeCategory } from "./privileges";
import type { ContractInfo, HolderPage } from "./explorer";
import { CallReverted, type ChainReader, type Finding, type InspectInput } from "./types";

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

const FORWARDS_TO_UNIDENTIFIED_TITLE = "Forwards calls to unidentified code";
const FORWARDS_TO_UNIDENTIFIED_DETAIL =
  "The code contains a DELEGATECALL, but no EIP-1167 clone target or EIP-1967 proxy slot could be resolved.";

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
  "logic-ambiguous": { title: "Couldn't read the contract's logic", detail: "Both the EIP-1967 implementation and beacon slots are set, and only this proxy's own bytecode decides which of the two it runs — so which code to read can't be told." },
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
 * `mutable` (R1): the code can be replaced — this address's own EIP-1967 slots are set, or it is a
 * clone of a contract whose are (exactly the condition `checkProxy` fails on, read from the same
 * value so the two can never disagree). "No privileged functions", "Ownership is renounced", "No
 * owner function" and "Doesn't rely on on-chain randomness" are then statements about code that
 * can be different tomorrow. They stay true of the logic running NOW, which is why this downgrades
 * to a `warn` naming who can replace it rather than to an `unknown`.
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
 * `forwards-unknown`: this address's own EIP-1967 slots couldn't be read, so whether the code being
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
    detail: "This contract's EIP-1967 proxy slots couldn't be read, so whether the code scanned here is the code that actually runs was never established.",
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

export type Pool = { address: Address; version: "v2" | "v3"; quote: string; depth: bigint };

/**
 * What the pool lookup found, and whether the DEX factories answered at all. An address with no
 * contract code reverts every call it's given, which reaches this code as "no pair" — identical to
 * a working factory saying there is no pool. "No Uniswap pool found" read off a factory that never
 * answered is a claim about pools that nothing actually checked.
 */
export type PoolScan = { pools: Pool[]; factoriesAnswered: boolean };

/** Distinguishes "the factory reverted" from "the factory answered the zero address". */
const REVERTED = Symbol("factory call reverted");

/** Rejects if any call fails at the transport level — the caller decides what "pools unknown" means. */
export async function findPools(input: InspectInput): Promise<PoolScan> {
  const { dex, reader, address } = input;
  if (!dex) return { pools: [], factoriesAnswered: false };
  let factoriesAnswered = false;
  const askFactory = async (factory: Address, abi: typeof v2FactoryAbi | typeof v3FactoryAbi, fn: string, args: unknown[]): Promise<unknown> => {
    const answer = await catchReverted<unknown>(reader.read(factory, abi, fn, args), REVERTED);
    if (answer === REVERTED) return null;
    factoriesAnswered = true;
    return answer;
  };
  const add = async (pool: unknown, version: Pool["version"], quote: { address: Address; symbol: string }): Promise<Pool | null> => {
    if (typeof pool !== "string" || lower(pool) === ZERO) return null;
    const depth = await catchReverted(reader.read(quote.address, erc20Abi, "balanceOf", [pool]) as Promise<bigint>, 0n);
    return { address: pool as Address, version, quote: quote.symbol, depth };
  };
  const perQuote = dex.quoteTokens
    .filter((quote) => lower(quote.address) !== lower(address))
    .map(async (quote) => {
      const [v2Pool, v3Pools] = await Promise.all([
        askFactory(dex.v2Factory, v2FactoryAbi, "getPair", [address, quote.address]).then((pair) => add(pair, "v2", quote)),
        Promise.all(
          dex.v3FeeTiers.map((fee) =>
            askFactory(dex.v3Factory, v3FactoryAbi, "getPool", [address, quote.address, fee]).then((pool) => add(pool, "v3", quote)),
          ),
        ),
      ]);
      return [v2Pool, ...v3Pools];
    });
  const results = await Promise.all(perQuote);
  return { pools: results.flat().filter((p): p is Pool => p !== null), factoriesAnswered };
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
  /** Only meaningful when `cloneOf` is set: both of the target's EIP-1967 slot reads answered.
   * When they didn't, `upgradeable === false` means "not read", not "not set", so the clone can't
   * be called non-upgradeable. */
  targetSlotsRead: boolean;
  /** DELEGATECALL is present but resolves to no known clone target or EIP-1967 slot. */
  forwardsToUnidentifiedCode: boolean;
  /** The code finally scored as this token's logic contains a DELEGATECALL of its own. A clone is
   * not re-pointable, but "its logic can't be replaced" is a claim about the code that ends up
   * running, and whoever controls the address behind that DELEGATECALL controls exactly that. */
  logicDelegates: boolean;
  /** The code this token runs can be replaced: its own EIP-1967 implementation or beacon slot is
   * set, or it is a clone of a contract whose is. THE value — `checkProxy`'s upgradeability `fail`
   * and R1's block on the logic checks (`LogicBlock`) both read this one field, so the report can
   * never say "upgradeable proxy" and "ownership is renounced" side by side. */
  upgradeable: boolean;
  /** The EIP-1967 admin slot of whichever address makes this upgradeable, when it holds one.
   * `null` covers all three of: not upgradeable, slot empty (UUPS or beacon), slot unreadable —
   * they produce the same finding text ("whoever controls upgrades"), because the one thing that
   * must never be said is a name that wasn't read. */
  admin: Address | null;
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
      return finding("proxy", "fail", "Clone of an upgradeable proxy", `An EIP-1167 clone of ${r.cloneOf}, which is itself an EIP-1967 upgradeable proxy — ${who}can replace what this token's logic actually delegates to.`, { evidenceUrl: targetUrl });
    }
    if (!r.targetSlotsRead) {
      return finding("proxy", "unknown", "Couldn't check if this clone is upgradeable", `This is an EIP-1167 clone of ${r.cloneOf}, whose own EIP-1967 proxy slots couldn't be read.`, { evidenceUrl: targetUrl });
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
    const title = r.admin ? `Upgradeable — admin ${shortAddress(r.admin)}` : "Upgradeable proxy";
    const detail = r.admin
      ? `${r.admin} holds the EIP-1967 admin slot and can replace this contract's logic.`
      : "Whoever controls the proxy admin can replace this contract's logic.";
    return finding("proxy", "fail", title, detail, { evidenceUrl: url });
  }
  return finding("proxy", "pass", "Not a proxy", "No EIP-1967 proxy slots are set and the code doesn't delegate calls.", { evidenceUrl: url });
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
  const skip = new Set([lower(input.address), ...knownPools.map((p) => lower(p.address)), ...input.knownLockers.map(lower)]);
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

/** 1,000 units of a 6-decimal quote token. */
const MIN_DEPTH = 1_000_000_000n;
const FACTORIES_SILENT =
  "Every call to the configured Uniswap factories reverted, so no pool was found or ruled out — the factory address may hold no contract on this network.";

export function checkLiquidity(input: InspectInput, scan: PoolScan | null): Finding {
  if (!input.dex) return finding("liquidity", "unknown", "Liquidity isn't checked on this network", "No DEX registry is configured here.");
  if (scan === null) return finding("liquidity", "unknown", "Couldn't read liquidity pools", "The network didn't answer the pool lookup.");
  if (!scan.factoriesAnswered) return finding("liquidity", "unknown", "Couldn't read liquidity pools", FACTORIES_SILENT);
  const pools = scan.pools;
  if (pools.length === 0) return finding("liquidity", "warn", "No Uniswap v2 or v3 pool found", "Pools against USDC or EURC only. Uniswap v4 and Aerodrome pools aren't scanned yet.");
  const best = pools.reduce((a, b) => (b.depth > a.depth ? b : a));
  const units = (best.depth / 1_000_000n).toLocaleString("en-US");
  const url = `${input.explorerBase}/address/${best.address}`;
  return best.depth >= MIN_DEPTH
    ? finding("liquidity", "pass", `${units} ${best.quote} of liquidity on Uniswap ${best.version}`, `${pools.length} pool(s) found.`, { evidenceUrl: url })
    : finding("liquidity", "warn", "Thin liquidity", `Deepest pool holds ${units} ${best.quote}.`, { evidenceUrl: url });
}

export async function checkLpLock(input: InspectInput, scan: PoolScan | null): Promise<Finding> {
  if (!input.dex) return finding("lp-lock", "unknown", "Locks aren't checked on this network", "No DEX registry is configured here.");
  if (scan === null) return finding("lp-lock", "unknown", "Couldn't read liquidity pools", "The network didn't answer the pool lookup.");
  const v2 = scan.pools.filter((p) => p.version === "v2");
  if (v2.length === 0) {
    const why = !scan.factoriesAnswered
      ? FACTORIES_SILENT
      : scan.pools.length === 0 ? "No pool was found." : "Only Uniswap v3 pools were found; position locks need an indexer, which arrives with Radar.";
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
