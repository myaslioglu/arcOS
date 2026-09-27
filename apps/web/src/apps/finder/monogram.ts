/**
 * Up to three characters of a token's symbol for its Finder tile, or null for the Coins glyph.
 * A symbol is whatever the contract's deployer typed, so only ASCII A-Z and 0-9 survive, filtered
 * before uppercasing: "ſ" (long s) or "ß" would otherwise uppercase into "S" or "SS" and lend a
 * look-alike symbol the monogram of the token it imitates.
 */
export function tokenMonogram(symbol: string): string | null {
  const kept = symbol.replace(/[^A-Za-z0-9]/g, "").slice(0, 3).toUpperCase();
  return kept === "" ? null : kept;
}

const ACCENTS = [
  { hue: "var(--accent)", text: "var(--accent-text)" },
  { hue: "var(--accent-2)", text: "var(--accent-2-text)" },
  { hue: "var(--accent-3)", text: "var(--accent-3-text)" },
] as const;

/** A tile's colour for a graphic, and its text-safe twin for the monogram's letters. */
export type TokenHue = (typeof ACCENTS)[number];

/** One of the accent tokens, picked from the address, so a token keeps its colour and letter case doesn't matter. */
export function tokenHue(address: string): TokenHue {
  let h = 0;
  for (const ch of address.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return ACCENTS[h % ACCENTS.length];
}
