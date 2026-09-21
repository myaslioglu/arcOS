/**
 * Check rules — when each answers "unknown" (a failed or missing read is never silently a "pass"):
 * - verified: the explorer didn't answer.
 * - ownership: owner()/getOwner() failed at the network level (a revert just means "try the next
 *   name"); or there's no owner function and the contract's logic code couldn't be read at all, so
 *   whether anyone controls it can't be told either way; or there's no owner function but the
 *   contract does have privileged functions (in logic code that WAS read), so who (if anyone) can
 *   call them can't be read.
 * - privileges: the contract's logic code couldn't be read (clone whose implementation is
 *   unreachable or came back empty, or the code delegates calls to a target this check couldn't
 *   identify at all); or privileged functions were found but the owner is unknown, or there's no
 *   owner function at all (can't tell if they're reachable either way).
 * - proxy: a storage-read failure on the top-level address propagates and is caught by the
 *   orchestrator's guard; an EIP-1167 clone whose implementation couldn't be fetched at all (a
 *   transport failure) is unknown, never "not upgradeable"; a clone whose target read succeeded but
 *   came back with no code at all is a fail (it points at nothing); a resolved clone whose target is
 *   itself an EIP-1967 proxy is a fail ("Clone of an upgradeable proxy"), not a pass; code that
 *   delegates calls (DELEGATECALL) but resolves to no known clone target or EIP-1967 slot is
 *   unknown, not "not a proxy".
 * - holders: the explorer didn't answer, total supply is unknown, or the holder list came back
 *   empty — which is never treated as "0% concentration" once total supply is known to be non-zero
 *   (a non-zero supply guarantees at least one holder exists), regardless of what the explorer's own
 *   holders-count field claims — or (with a DEX configured) pool discovery failed, so pools can't be
 *   excluded from the holder list.
 * - liquidity: no DEX is configured for this network, or pool discovery failed at the network level.
 * - lp-lock: no DEX is configured, pool discovery failed, only Uniswap v3 pools exist (position
 *   locks need an indexer, which arrives with Radar), or the v2 pair's LP totalSupply is zero (no
 *   evidence to compute a locked share from).
 * - prevrandao: the contract's logic code couldn't be read (clone whose implementation is
 *   unreachable, or the code delegates calls to a target this check couldn't identify at all).
 */
import { parseAbi } from "viem";
import { BURN_ADDRESSES, type Address } from "@arcos/chain";
import { usesOpcode } from "./bytecode";
import { SEVERE, type Privilege, type PrivilegeCategory } from "./privileges";
import type { Holder } from "./explorer";
import { CallReverted, type ChainReader, type Finding, type InspectInput } from "./types";

export const erc20Abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const ownableAbi = parseAbi(["function owner() view returns (address)", "function getOwner() view returns (address)"]);
const v2FactoryAbi = parseAbi(["function getPair(address,address) view returns (address)"]);
const v3FactoryAbi = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);

const PROXY_LOGIC_UNREADABLE = "This is a minimal proxy and its implementation's code couldn't be fetched.";
const FORWARDS_TO_UNIDENTIFIED_TITLE = "This contract forwards calls to code that couldn't be identified";
const FORWARDS_TO_UNIDENTIFIED_DETAIL =
  "The code contains a DELEGATECALL, but no EIP-1167 clone target or EIP-1967 proxy slot could be resolved.";
const ZERO = "0x0000000000000000000000000000000000000000";
const GRANT_ROLE = "0x2f2ff15d";
const lower = (a: string) => a.toLowerCase();
const isBurn = (a: string) => BURN_ADDRESSES.some((b) => lower(b) === lower(a));

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
  | { kind: "roles" }
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
    if (isBurn(owner)) return { kind: "renounced" };
    try {
      return { kind: (await reader.getCode(owner)) ? "contract" : "wallet", address: owner };
    } catch {
      return { kind: "unknown" };
    }
  }
  return selectors.has(GRANT_ROLE) ? { kind: "roles" } : { kind: "none" };
}

export type Pool = { address: Address; version: "v2" | "v3"; quote: string; depth: bigint };

/** Rejects if any call fails at the transport level — the caller decides what "pools unknown" means. */
export async function findPools(input: InspectInput): Promise<Pool[]> {
  const { dex, reader, address } = input;
  if (!dex) return [];
  const add = async (pool: unknown, version: Pool["version"], quote: { address: Address; symbol: string }): Promise<Pool | null> => {
    if (typeof pool !== "string" || lower(pool) === ZERO) return null;
    const depth = await catchReverted(reader.read(quote.address, erc20Abi, "balanceOf", [pool]) as Promise<bigint>, 0n);
    return { address: pool as Address, version, quote: quote.symbol, depth };
  };
  const perQuote = dex.quoteTokens
    .filter((quote) => lower(quote.address) !== lower(address))
    .map(async (quote) => {
      const [v2Pool, v3Pools] = await Promise.all([
        catchReverted(reader.read(dex.v2Factory, v2FactoryAbi, "getPair", [address, quote.address]), null).then((pair) => add(pair, "v2", quote)),
        Promise.all(
          dex.v3FeeTiers.map((fee) =>
            catchReverted(reader.read(dex.v3Factory, v3FactoryAbi, "getPool", [address, quote.address, fee]), null).then((pool) => add(pool, "v3", quote)),
          ),
        ),
      ]);
      return [v2Pool, ...v3Pools];
    });
  const results = await Promise.all(perQuote);
  return results.flat().filter((p): p is Pool => p !== null);
}

const finding = (id: Finding["id"], status: Finding["status"], title: string, detail: string, extra: Partial<Finding> = {}): Finding => ({
  id, status, title, detail, evidenceUrl: null, fixAppId: null, ...extra,
});

export function checkVerified(input: InspectInput, verified: boolean | null): Finding {
  const url = `${input.explorerBase}/address/${input.address}?tab=contract`;
  if (verified === null) return finding("verified", "unknown", "Couldn't check source verification", "The explorer didn't answer.", { evidenceUrl: url });
  return verified
    ? finding("verified", "pass", "Source code is verified", "Anyone can read what this contract does.", { evidenceUrl: url })
    : finding("verified", "fail", "Source code isn't verified", "Only bytecode is public, so its behaviour can't be read directly.", { evidenceUrl: url });
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
  if (owner.kind === "renounced") return finding("ownership", "pass", "Ownership is renounced", "owner() is a burn address.", { evidenceUrl: url });
  if (owner.kind === "none") {
    if (found === null) {
      return finding("ownership", "unknown", "Couldn't read the contract's logic", "The contract's logic code couldn't be read, so it can't tell whether anyone controls it.", { evidenceUrl: url });
    }
    return found.length > 0
      ? finding("ownership", "unknown", "No owner function, but the contract has privileged functions", "The contract exposes no owner() or getOwner(), but its code has privileged functions — who (if anyone) can call them can't be read.", { evidenceUrl: url })
      : finding("ownership", "pass", "No owner function", "The contract exposes no owner() or getOwner().", { evidenceUrl: url });
  }
  if (owner.kind === "roles") return finding("ownership", "warn", "Role-based admin", "Uses AccessControl; role holders can't be listed from bytecode.", { evidenceUrl: url });
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
export function checkPrivileges(input: InspectInput, found: Privilege[] | null, forwardsToUnidentifiedCode: boolean, owner: Owner): Finding {
  const url = `${input.explorerBase}/address/${input.address}?tab=write_contract`;
  if (found === null) {
    return forwardsToUnidentifiedCode
      ? finding("privileges", "unknown", FORWARDS_TO_UNIDENTIFIED_TITLE, FORWARDS_TO_UNIDENTIFIED_DETAIL, { evidenceUrl: url })
      : finding("privileges", "unknown", "Couldn't read the contract's logic", PROXY_LOGIC_UNREADABLE, { evidenceUrl: url });
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
    return finding("privileges", "unknown", "Privileged functions found, but who can call them can't be read", `Found: ${list}.`, { evidenceUrl: url });
  }
  const worst = found.find((p) => SEVERE.includes(p.category)) ?? found[0]!;
  const status = SEVERE.includes(worst.category) ? "fail" : "warn";
  return finding("privileges", status, PRIVILEGE_TITLE[worst.category], `Found: ${list}.`, { evidenceUrl: url });
}

export const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
export const slotSet = (v: string | null) => v !== null && /[1-9a-f]/i.test(v.slice(2));
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
  /** Only meaningful when `cloneOf` is set and the target's code was actually read: the target's
   * own EIP-1967 slots are set too. */
  cloneTargetIsProxy: boolean;
  /** DELEGATECALL is present but resolves to no known clone target or EIP-1967 slot. */
  forwardsToUnidentifiedCode: boolean;
  /** Only meaningful when `cloneOf` is null: this address's own EIP-1967 slots are set. */
  topSlotsSet: boolean;
};

export function checkProxy(input: InspectInput, r: ProxyResolution): Finding {
  const url = `${input.explorerBase}/address/${input.address}?tab=contract`;
  if (r.cloneOf) {
    const targetUrl = `${input.explorerBase}/address/${r.cloneOf}`;
    if (r.cloneReadFailed) {
      return finding("proxy", "unknown", "Couldn't check whether this clone is upgradeable", `This is an EIP-1167 clone that forwards to ${r.cloneOf}, whose code couldn't be read.`, { evidenceUrl: targetUrl });
    }
    if (r.cloneTargetEmpty) {
      return finding("proxy", "fail", "Clone points at an address with no code", `An EIP-1167 clone of ${r.cloneOf}, which has no contract code at all — calls to it will fail.`, { evidenceUrl: targetUrl });
    }
    if (r.cloneTargetIsProxy) {
      return finding("proxy", "fail", "Clone of an upgradeable proxy", `An EIP-1167 clone of ${r.cloneOf}, which is itself an EIP-1967 upgradeable proxy — whoever controls it can replace what this token's logic actually delegates to.`, { evidenceUrl: targetUrl });
    }
    return finding("proxy", "pass", "Minimal proxy — not upgradeable", `An EIP-1167 clone of ${r.cloneOf}; its logic can't be replaced.`, { evidenceUrl: targetUrl });
  }
  if (r.forwardsToUnidentifiedCode) {
    return finding("proxy", "unknown", FORWARDS_TO_UNIDENTIFIED_TITLE, FORWARDS_TO_UNIDENTIFIED_DETAIL, { evidenceUrl: url });
  }
  if (r.topSlotsSet) return finding("proxy", "fail", "Upgradeable proxy", "Whoever controls the proxy admin can replace this contract's logic.", { evidenceUrl: url });
  return finding("proxy", "pass", "Not a proxy", "No EIP-1967 proxy slots are set and the code doesn't delegate calls.", { evidenceUrl: url });
}

export function checkHolders(input: InspectInput, holders: Holder[] | null, totalSupply: bigint | null, pools: Pool[] | null): Finding {
  const url = `${input.explorerBase}/token/${input.address}?tab=holders`;
  if (holders === null || !totalSupply) return finding("holders", "unknown", "Couldn't check holder concentration", "The explorer didn't answer, or total supply is unknown.", { evidenceUrl: url });
  // totalSupply > 0 (just checked above) guarantees at least one holder exists, so an empty list
  // here is never "0% concentration" — it's the explorer not having indexed this token yet. This
  // holds regardless of what the explorer's own holders-count field claims: a non-zero supply next
  // to a claimed holder count of 0 is itself a contradiction, not confirmation of "no holders".
  if (holders.length === 0) {
    return finding("holders", "unknown", "Couldn't check holder concentration", "The explorer returned no holders for a token with non-zero supply, which usually means it hasn't indexed this token yet.", { evidenceUrl: url });
  }
  if (pools === null && input.dex) {
    return finding("holders", "unknown", "Couldn't check holder concentration", "The pool lookup failed, so a liquidity pool could be miscounted as a whale.", { evidenceUrl: url });
  }
  const knownPools = pools ?? [];
  const skip = new Set([lower(input.address), ...knownPools.map((p) => lower(p.address)), ...input.knownLockers.map(lower)]);
  const ranked = [...holders].sort((a, b) => (a.value < b.value ? 1 : a.value > b.value ? -1 : 0));
  const top = ranked.filter((h) => !isBurn(h.address) && !skip.has(lower(h.address))).slice(0, 10);
  const held = top.reduce((sum, h) => sum + h.value, 0n);
  const pct = Number((held * 10000n) / totalSupply) / 100;
  const title = `Top 10 wallets hold ${formatPct(pct)}`;
  const detail = "Excludes burn addresses, liquidity pools and known lock contracts.";
  if (pct > 50) return finding("holders", "fail", title, detail, { evidenceUrl: url, fixAppId: "vesting" });
  if (pct > 25) return finding("holders", "warn", title, detail, { evidenceUrl: url });
  return finding("holders", "pass", title, detail, { evidenceUrl: url });
}

/** 1,000 units of a 6-decimal quote token. */
const MIN_DEPTH = 1_000_000_000n;

export function checkLiquidity(input: InspectInput, pools: Pool[] | null): Finding {
  if (!input.dex) return finding("liquidity", "unknown", "Liquidity isn't checked on this network", "No DEX registry is configured here.");
  if (pools === null) return finding("liquidity", "unknown", "Couldn't read liquidity pools", "The network didn't answer the pool lookup.");
  if (pools.length === 0) return finding("liquidity", "warn", "No Uniswap v2 or v3 pool found", "Pools against USDC or EURC only. Uniswap v4 and Aerodrome pools aren't scanned yet.");
  const best = pools.reduce((a, b) => (b.depth > a.depth ? b : a));
  const units = (best.depth / 1_000_000n).toLocaleString("en-US");
  const url = `${input.explorerBase}/address/${best.address}`;
  return best.depth >= MIN_DEPTH
    ? finding("liquidity", "pass", `${units} ${best.quote} of liquidity on Uniswap ${best.version}`, `${pools.length} pool(s) found.`, { evidenceUrl: url })
    : finding("liquidity", "warn", "Thin liquidity", `Deepest pool holds ${units} ${best.quote}.`, { evidenceUrl: url });
}

export async function checkLpLock(input: InspectInput, pools: Pool[] | null): Promise<Finding> {
  if (!input.dex) return finding("lp-lock", "unknown", "Liquidity locks aren't checked on this network", "No DEX registry is configured here.");
  if (pools === null) return finding("lp-lock", "unknown", "Couldn't read liquidity pools", "The network didn't answer the pool lookup.");
  const v2 = pools.filter((p) => p.version === "v2");
  if (v2.length === 0) {
    const why = pools.length === 0 ? "No pool was found." : "Only Uniswap v3 pools were found; position locks need an indexer, which arrives with Radar.";
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

export function checkPrevrandao(input: InspectInput, logicCode: string | null, forwardsToUnidentifiedCode: boolean): Finding {
  if (logicCode === null) {
    return forwardsToUnidentifiedCode
      ? finding("prevrandao", "unknown", FORWARDS_TO_UNIDENTIFIED_TITLE, FORWARDS_TO_UNIDENTIFIED_DETAIL)
      : finding("prevrandao", "unknown", "Couldn't read the contract's logic", PROXY_LOGIC_UNREADABLE);
  }
  return usesOpcode(logicCode, 0x44)
    ? finding("prevrandao", "warn", "Uses PREVRANDAO, which is always 0 on Arc", "Any randomness derived from it is predictable.", { evidenceUrl: "https://docs.arc.io/arc/references/evm-differences" })
    : finding("prevrandao", "pass", "Doesn't rely on on-chain randomness", "The PREVRANDAO opcode isn't used.");
}
