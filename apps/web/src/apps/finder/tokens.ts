import { EURC, USDC, type NetworkId } from "@arcos/chain";
import type { TokenBalance } from "@arcos/inspector";

export type TokenFile = {
  address: string;
  symbol: string;
  name: string | null;
  decimals: number;
  balance: bigint | null;
  createdByYou: boolean;
};

export function mergeTokens(
  holdings: TokenBalance[],
  created: { address: string; symbol: string; decimals: number }[],
): TokenFile[] {
  const held = new Map(holdings.map((h) => [h.address.toLowerCase(), h]));
  const mine: TokenFile[] = [...created].reverse().map((c) => {
    const h = held.get(c.address.toLowerCase());
    held.delete(c.address.toLowerCase());
    return { address: c.address, symbol: c.symbol, name: h?.name ?? null, decimals: c.decimals, balance: h?.value ?? null, createdByYou: true };
  });
  const rest: TokenFile[] = [...held.values()]
    .map((h) => ({ address: h.address, symbol: h.symbol ?? "?", name: h.name, decimals: h.decimals, balance: h.value, createdByYou: false }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  return [...mine, ...rest];
}

/** Lower-cased symbols that appear on more than one token in the list. */
export function duplicateSymbols(files: TokenFile[]): Set<string> {
  const addressesBySymbol = new Map<string, Set<string>>();
  for (const f of files) {
    const symbol = f.symbol.trim().toLowerCase();
    const addresses = addressesBySymbol.get(symbol) ?? new Set<string>();
    addresses.add(f.address.toLowerCase());
    addressesBySymbol.set(symbol, addresses);
  }
  const duplicates = new Set<string>();
  for (const [symbol, addresses] of addressesBySymbol) {
    if (addresses.size > 1) duplicates.add(symbol);
  }
  return duplicates;
}

/** "USDC" or "EURC" when `address` is that token's real, canonical contract on `network`; else null. */
export function officialSymbol(address: string, network: NetworkId): "USDC" | "EURC" | null {
  const a = address.toLowerCase();
  if (a === USDC.toLowerCase()) return "USDC";
  if (a === EURC[network].toLowerCase()) return "EURC";
  return null;
}
