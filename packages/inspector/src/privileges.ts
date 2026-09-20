import { toFunctionSelector } from "viem";

export type PrivilegeCategory = "mint" | "blacklist" | "fees" | "limits" | "pause";
export type Privilege = { category: PrivilegeCategory; signature: string };

/** Categories that let an owner take value from holders. The rest only restrict trading. */
export const SEVERE: PrivilegeCategory[] = ["mint", "blacklist", "fees"];

const ORDER: PrivilegeCategory[] = ["mint", "blacklist", "fees", "limits", "pause"];

const SIGNATURES: Record<PrivilegeCategory, string[]> = {
  mint: [
    "mint(address,uint256)",
    "mint(uint256)",
    "mintTo(address,uint256)",
    "issue(uint256)",
    "safeMint(address,uint256)",
    "mintTokens(address,uint256)",
    "ownerMint(address,uint256)",
    "adminMint(address,uint256)",
    "batchMint(address[],uint256[])",
  ],
  blacklist: [
    "blacklist(address)",
    "addToBlacklist(address)",
    "setBlacklist(address,bool)",
    "blacklistAddress(address,bool)",
    "blockAddress(address)",
    "setBot(address,bool)",
    "addBot(address)",
    "setBots(address[],bool)",
    "addBots(address[])",
    "addBlackList(address)",
    "removeBlackList(address)",
    "addToBlackList(address)",
    "blacklist(address,bool)",
    "setBlacklisted(address,bool)",
    "setIsBlacklisted(address,bool)",
    "freeze(address)",
    "freezeAccount(address,bool)",
    "destroyBlackFunds(address)",
    "blockAccount(address)",
    "delBot(address)",
  ],
  fees: [
    "setFee(uint256)",
    "setFees(uint256,uint256)",
    "setTaxes(uint256,uint256)",
    "setBuyFee(uint256)",
    "setSellFee(uint256)",
    "setBuyTax(uint256)",
    "setSellTax(uint256)",
    "updateFees(uint256,uint256)",
    "setTaxFeePercent(uint256)",
    "excludeFromFee(address)",
    "includeInFee(address)",
    "excludeFromFees(address,bool)",
    "removeAllFee()",
    "restoreAllFee()",
    "setMarketingFee(uint256)",
    "setLiquidityFeePercent(uint256)",
    "updateBuyFees(uint256,uint256,uint256)",
    "updateSellFees(uint256,uint256,uint256)",
  ],
  limits: [
    "setMaxTxAmount(uint256)",
    "setMaxTxPercent(uint256)",
    "setMaxWallet(uint256)",
    "setMaxWalletSize(uint256)",
    "setMaxWalletAmount(uint256)",
    "setMaxTransactionAmount(uint256)",
    "updateMaxTxnAmount(uint256)",
    "updateMaxWalletAmount(uint256)",
  ],
  pause: [
    "pause()",
    "unpause()",
    "setTradingEnabled(bool)",
    "setTrading(bool)",
    "enableTrading()",
    "openTrading()",
    "startTrading()",
    "disableTrading()",
    "pauseTrading()",
    "setTradingActive(bool)",
  ],
};

const BY_SELECTOR = new Map<string, Privilege>();
for (const category of ORDER) {
  for (const signature of SIGNATURES[category]) {
    BY_SELECTOR.set(toFunctionSelector(signature), { category, signature });
  }
}

const byCategory = (a: Privilege, b: Privilege) =>
  ORDER.indexOf(a.category) - ORDER.indexOf(b.category) || a.signature.localeCompare(b.signature);

export function privilegesFromSelectors(selectors: Set<string>): Privilege[] {
  const out: Privilege[] = [];
  for (const s of selectors) {
    const hit = BY_SELECTOR.get(s.toLowerCase());
    if (hit) out.push(hit);
  }
  return out.sort(byCategory);
}

/**
 * Union of what a verified ABI says and what the bytecode's dispatcher actually contains,
 * de-duplicated. Evidence from one source never suppresses the other — in particular, an empty
 * (but present) ABI array must never skip the bytecode scan: a contract can be "verified" with an
 * incomplete or stale ABI while its deployed code still dispatches a privileged selector.
 */
export function combinePrivileges(abi: readonly unknown[] | null, selectors: Set<string>): Privilege[] {
  const fromAbi = abi && abi.length > 0 ? privilegesFromAbi(abi) : [];
  const fromSelectors = privilegesFromSelectors(selectors);
  const seen = new Set<string>();
  const out: Privilege[] = [];
  for (const p of [...fromAbi, ...fromSelectors]) {
    const key = `${p.category}:${p.signature}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out.sort(byCategory);
}

const NAME_RULES: [PrivilegeCategory, RegExp][] = [
  ["mint", /^(mint|issue)$|^(safe|owner|admin|batch)mint|^mint(to|tokens|batch)$/i],
  ["blacklist", /(black|block)list|antibot|^(set|add|del|remove)bots?$|^(un)?freeze|^blockaccount$|^destroyblackfunds$/i],
  ["fees", /^(set|update|change).*(fee|tax)|^(exclude|include)(from|in)fees?$|^(remove|restore)allfees?$/i],
  ["limits", /^(set|update).*max/i],
  ["pause", /^(pause|unpause)$|^(enable|open|start|disable|pause|set|toggle).*trading/i],
];

/** For verified contracts: state-changing functions whose names match a privilege pattern. */
export function privilegesFromAbi(abi: readonly unknown[]): Privilege[] {
  const out: Privilege[] = [];
  for (const entry of abi) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as { type?: unknown; name?: unknown; stateMutability?: unknown };
    if (e.type !== "function" || typeof e.name !== "string") continue;
    if (e.stateMutability === "view" || e.stateMutability === "pure") continue;
    const rule = NAME_RULES.find(([, re]) => re.test(e.name as string));
    if (rule) out.push({ category: rule[0], signature: e.name });
  }
  return out.sort(byCategory);
}
