import { parseAbi } from "viem";
import { BURN_ADDRESSES, type Address } from "@arcos/chain";
import { usesOpcode, extractSelectors } from "./bytecode";
import { SEVERE, privilegesFromAbi, privilegesFromSelectors, type Privilege, type PrivilegeCategory } from "./privileges";
import type { Holder } from "./explorer";
import type { ChainReader, Finding, InspectInput } from "./types";

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

const ZERO = "0x0000000000000000000000000000000000000000";
const GRANT_ROLE = "0x2f2ff15d";
const lower = (a: string) => a.toLowerCase();
const isBurn = (a: string) => BURN_ADDRESSES.some((b) => lower(b) === lower(a));

export type Owner = { kind: "none" } | { kind: "renounced" } | { kind: "roles" } | { kind: "wallet" | "contract"; address: Address };

export async function resolveOwner(reader: ChainReader, token: Address, selectors: Set<string>): Promise<Owner> {
  for (const fn of ["owner", "getOwner"]) {
    try {
      const owner = (await reader.read(token, ownableAbi, fn)) as Address;
      if (isBurn(owner)) return { kind: "renounced" };
      return { kind: (await reader.getCode(owner)) ? "contract" : "wallet", address: owner };
    } catch {
      // no such function — try the next name
    }
  }
  return selectors.has(GRANT_ROLE) ? { kind: "roles" } : { kind: "none" };
}

export type Pool = { address: Address; version: "v2" | "v3"; quote: string; depth: bigint };

export async function findPools(input: InspectInput): Promise<Pool[]> {
  const { dex, reader, address } = input;
  if (!dex) return [];
  const pools: Pool[] = [];
  const add = async (pool: unknown, version: Pool["version"], quote: { address: Address; symbol: string }) => {
    if (typeof pool !== "string" || lower(pool) === ZERO) return;
    const depth = (await reader.read(quote.address, erc20Abi, "balanceOf", [pool]).catch(() => 0n)) as bigint;
    pools.push({ address: pool as Address, version, quote: quote.symbol, depth });
  };
  for (const quote of dex.quoteTokens) {
    if (lower(quote.address) === lower(address)) continue;
    await add(await reader.read(dex.v2Factory, v2FactoryAbi, "getPair", [address, quote.address]).catch(() => null), "v2", quote);
    for (const fee of dex.v3FeeTiers) {
      await add(await reader.read(dex.v3Factory, v3FactoryAbi, "getPool", [address, quote.address, fee]).catch(() => null), "v3", quote);
    }
  }
  return pools;
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

export function checkOwnership(input: InspectInput, owner: Owner): Finding {
  const url = `${input.explorerBase}/address/${input.address}?tab=read_contract`;
  if (owner.kind === "renounced") return finding("ownership", "pass", "Ownership is renounced", "owner() is a burn address.", { evidenceUrl: url });
  if (owner.kind === "none") return finding("ownership", "pass", "No owner function", "The contract exposes no owner() or getOwner().", { evidenceUrl: url });
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
  pause: "Owner can pause trading",
};

export function checkPrivileges(input: InspectInput, logicCode: string, abi: readonly unknown[] | null, owner: Owner): Finding {
  const found: Privilege[] = abi ? privilegesFromAbi(abi) : privilegesFromSelectors(extractSelectors(logicCode));
  const url = `${input.explorerBase}/address/${input.address}?tab=write_contract`;
  const list = found.map((p) => p.signature).join(", ");
  if (found.length === 0) return finding("privileges", "pass", "No privileged functions found", "No mint, blacklist, fee, limit or pause function in the dispatcher.", { evidenceUrl: url });
  if (owner.kind === "renounced" || owner.kind === "none") {
    return finding("privileges", "pass", "Privileged functions can't be called", `Found ${list}, but ownership is renounced or absent.`, { evidenceUrl: url });
  }
  const worst = found.find((p) => SEVERE.includes(p.category)) ?? found[0]!;
  const status = SEVERE.includes(worst.category) ? "fail" : "warn";
  return finding("privileges", status, PRIVILEGE_TITLE[worst.category], `Found: ${list}.`, { evidenceUrl: url });
}

const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const slotSet = (v: string | null) => v !== null && /[1-9a-f]/i.test(v.slice(2));

export async function checkProxy(input: InspectInput, cloneOf: Address | null): Promise<Finding> {
  const url = `${input.explorerBase}/address/${input.address}?tab=contract`;
  if (cloneOf) return finding("proxy", "pass", "Minimal proxy — not upgradeable", `An EIP-1167 clone of ${cloneOf}; its logic can't be replaced.`, { evidenceUrl: `${input.explorerBase}/address/${cloneOf}` });
  const [impl, beacon] = await Promise.all([
    input.reader.getStorageAt(input.address, IMPL_SLOT),
    input.reader.getStorageAt(input.address, BEACON_SLOT),
  ]);
  if (slotSet(impl) || slotSet(beacon)) return finding("proxy", "fail", "Upgradeable proxy", "Whoever controls the proxy admin can replace this contract's logic.", { evidenceUrl: url });
  return finding("proxy", "pass", "Not a proxy", "The contract's logic can't be replaced.", { evidenceUrl: url });
}

export function checkHolders(input: InspectInput, holders: Holder[] | null, totalSupply: bigint | null, pools: Pool[]): Finding {
  const url = `${input.explorerBase}/token/${input.address}?tab=holders`;
  if (holders === null || !totalSupply) return finding("holders", "unknown", "Couldn't check holder concentration", "The explorer didn't answer, or total supply is unknown.", { evidenceUrl: url });
  const skip = new Set([lower(input.address), ...pools.map((p) => lower(p.address)), ...input.knownLockers.map(lower)]);
  const top = holders.filter((h) => !isBurn(h.address) && !skip.has(lower(h.address))).slice(0, 10);
  const held = top.reduce((sum, h) => sum + h.value, 0n);
  const pct = Number((held * 10000n) / totalSupply) / 100;
  const title = `Top 10 wallets hold ${Math.round(pct)}%`;
  const detail = "Excludes burn addresses, liquidity pools and known lock contracts.";
  if (pct > 50) return finding("holders", "fail", title, detail, { evidenceUrl: url, fixAppId: "vesting" });
  if (pct > 25) return finding("holders", "warn", title, detail, { evidenceUrl: url });
  return finding("holders", "pass", title, detail, { evidenceUrl: url });
}

/** 1,000 units of a 6-decimal quote token. */
const MIN_DEPTH = 1_000_000_000n;

export function checkLiquidity(input: InspectInput, pools: Pool[]): Finding {
  if (!input.dex) return finding("liquidity", "unknown", "Liquidity isn't checked on this network", "No DEX registry is configured here.");
  if (pools.length === 0) return finding("liquidity", "warn", "No Uniswap v2 or v3 pool found", "Pools against USDC or EURC only. Uniswap v4 and Aerodrome pools aren't scanned yet.");
  const best = pools.reduce((a, b) => (b.depth > a.depth ? b : a));
  const units = (best.depth / 1_000_000n).toLocaleString("en-US");
  const url = `${input.explorerBase}/address/${best.address}`;
  return best.depth >= MIN_DEPTH
    ? finding("liquidity", "pass", `${units} ${best.quote} of liquidity on Uniswap ${best.version}`, `${pools.length} pool(s) found.`, { evidenceUrl: url })
    : finding("liquidity", "warn", "Thin liquidity", `Deepest pool holds ${units} ${best.quote}.`, { evidenceUrl: url });
}

export async function checkLpLock(input: InspectInput, pools: Pool[]): Promise<Finding> {
  if (!input.dex) return finding("lp-lock", "unknown", "Liquidity locks aren't checked on this network", "No DEX registry is configured here.");
  const v2 = pools.filter((p) => p.version === "v2");
  if (v2.length === 0) {
    const why = pools.length === 0 ? "No pool was found." : "Only Uniswap v3 pools were found; position locks need an indexer, which arrives with Radar.";
    return finding("lp-lock", "unknown", "Couldn't check liquidity locks", why, { fixAppId: pools.length ? "vault" : null });
  }
  const pair = v2.reduce((a, b) => (b.depth > a.depth ? b : a));
  const read = (fn: string, args: unknown[] = []) => input.reader.read(pair.address, erc20Abi, fn, args) as Promise<bigint>;
  const supply = await read("totalSupply");
  const safe = [...BURN_ADDRESSES, ...input.knownLockers];
  const balances = await Promise.all(safe.map((a) => read("balanceOf", [a]).catch(() => 0n)));
  const locked = balances.reduce((s, b) => s + b, 0n);
  const pct = supply === 0n ? 0 : Number((locked * 10000n) / supply) / 100;
  const url = `${input.explorerBase}/token/${pair.address}?tab=holders`;
  return pct >= 95
    ? finding("lp-lock", "pass", "Liquidity is burned or locked", `${Math.round(pct)}% of the v2 LP supply can't be withdrawn.`, { evidenceUrl: url })
    : finding("lp-lock", "fail", "Liquidity isn't locked", `${Math.round(100 - pct)}% of the v2 LP supply sits in wallets that can withdraw it.`, { evidenceUrl: url, fixAppId: "vault" });
}

export function checkPrevrandao(input: InspectInput, logicCode: string): Finding {
  return usesOpcode(logicCode, 0x44)
    ? finding("prevrandao", "warn", "Uses PREVRANDAO, which is always 0 on Arc", "Any randomness derived from it is predictable.", { evidenceUrl: "https://docs.arc.io/arc/references/evm-differences" })
    : finding("prevrandao", "pass", "Doesn't rely on on-chain randomness", "The PREVRANDAO opcode isn't used.");
}
