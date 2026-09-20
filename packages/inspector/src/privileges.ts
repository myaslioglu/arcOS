import { toFunctionSelector } from "viem";

export type PrivilegeCategory = "mint" | "blacklist" | "fees" | "limits" | "pause";
export type Privilege = { category: PrivilegeCategory; signature: string };

/** Categories that let an owner take value from holders. The rest only restrict trading. */
export const SEVERE: PrivilegeCategory[] = ["mint", "blacklist", "fees"];

const ORDER: PrivilegeCategory[] = ["mint", "blacklist", "fees", "limits", "pause"];

const SIGNATURES: Record<PrivilegeCategory, string[]> = {
  mint: ["mint(address,uint256)", "mint(uint256)", "mintTo(address,uint256)", "issue(uint256)"],
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
  ],
  limits: [
    "setMaxTxAmount(uint256)",
    "setMaxTxPercent(uint256)",
    "setMaxWallet(uint256)",
    "setMaxWalletSize(uint256)",
    "setMaxWalletAmount(uint256)",
  ],
  pause: ["pause()", "unpause()", "setTradingEnabled(bool)", "setTrading(bool)"],
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

const NAME_RULES: [PrivilegeCategory, RegExp][] = [
  ["mint", /^(mint|mintTo|issue)$/i],
  ["blacklist", /(blacklist|blocklist|antibot|^setbots?$|^addbots?$)/i],
  ["fees", /^(set|update|change).*(fee|tax)/i],
  ["limits", /^(set|update).*max/i],
  ["pause", /^(pause|unpause|set.*trading.*)$/i],
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
