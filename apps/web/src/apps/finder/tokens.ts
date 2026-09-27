import { EURC, USDC, type NetworkId } from "@arcos/chain";
import { cleanLabel, type TokenBalance } from "@arcos/inspector";

export type TokenFile = {
  address: string;
  symbol: string;
  name: string | null;
  /** null while the on-chain decimals() read is pending or has failed — never guessed at, since
   * that would show a balance at the wrong scale. */
  decimals: number | null;
  balance: bigint | null;
  createdByYou: boolean;
};

export function mergeTokens(
  holdings: TokenBalance[],
  created: { address: string; symbol: string; decimals: number | null }[],
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

/** Stand-ins the Finder shows for a symbol it hasn't got: `mergeTokens`' "?" for a holding the
 * explorer returned without one, and Window.tsx's "…" while the on-chain `symbol()` read is
 * pending or after it failed. Two of them side by side are the same absence, not two tokens
 * claiming the same name, so they must never be reported as a collision. */
const PLACEHOLDER_SYMBOLS = new Set(["…", "?"]);

/** The one way a symbol is turned into a comparison key: cleaned (control/format/zero-width
 * characters stripped, so a spoofed symbol still collides with the one it imitates), trimmed and
 * lower-cased. Exported because `duplicateSymbols`' caller has to look its own symbols up with the
 * same key — keying one side and querying with the other silently bypasses the whole check. */
export function symbolKey(symbol: string): string {
  return (cleanLabel(symbol, 32) ?? symbol).trim().toLowerCase();
}

/** Keys (see `symbolKey`) that appear on more than one token in the list, placeholders excluded. */
export function duplicateSymbols(files: TokenFile[]): Set<string> {
  const addressesBySymbol = new Map<string, Set<string>>();
  for (const f of files) {
    const symbol = symbolKey(f.symbol);
    if (PLACEHOLDER_SYMBOLS.has(symbol)) continue;
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

/**
 * Whether `symbol` is one of the duplicated ones — the only way the Finder should ask. Keying the
 * set and querying it are two halves of the same decision, so they live in one file and share
 * `symbolKey`: a call site that builds its own key (as the window used to) can drift from the set
 * and then quietly answer "no collisions" forever, which is exactly what this check is for.
 */
export function isDuplicateSymbol(duplicates: ReadonlySet<string>, symbol: string): boolean {
  return duplicates.has(symbolKey(symbol));
}

/** Start index for `tokensOfSlice` to page in the latest `size` items out of `count` total; never negative. */
export function latestSliceStart(count: bigint, size: number): bigint {
  const sizeBig = BigInt(size);
  return count > sizeBig ? count - sizeBig : 0n;
}

/** "USDC" or "EURC" when `address` is that token's real, canonical contract on `network`; else null. */
export function officialSymbol(address: string, network: NetworkId): "USDC" | "EURC" | null {
  const a = address.toLowerCase();
  if (a === USDC.toLowerCase()) return "USDC";
  if (a === EURC[network].toLowerCase()) return "EURC";
  return null;
}

/** How many tokens Finder draws at first, and how many more each "Show more" adds. */
export const FILES_PAGE = 200;

/**
 * The files Finder draws once the visitor has asked for `limit`: the tokens they created and the
 * official USDC and EURC first, never held back, then the rest in their order, up to `limit` in all.
 * The explorer returns every token a wallet holds at once, tens of thousands for some wallets, and
 * drawing them all makes the window crawl.
 */
export function visibleFiles(files: TokenFile[], limit: number, network: NetworkId): TokenFile[] {
  const first = (f: TokenFile) => f.createdByYou || officialSymbol(f.address, network) !== null;
  const pinned = files.filter(first);
  const rest = files.filter((f) => !first(f));
  return [...pinned, ...rest.slice(0, Math.max(0, limit - pinned.length))];
}

/** "Showing 200 of 31,837 tokens" while some are held back; null once every token is drawn. */
export function showingLine(shown: number, total: number): string | null {
  if (shown >= total) return null;
  const count = (n: number) => n.toLocaleString("en-US");
  return `Showing ${count(shown)} of ${count(total)} tokens`;
}
