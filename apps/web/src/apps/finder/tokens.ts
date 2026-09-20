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
