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

/**
 * Each accent for the tile, and for the letters its text twin mixed 15% toward the foreground: on
 * the 13% tint of the tile the twins alone sit at 4.3-4.9:1 in light, the mix at 5.3-6.0:1 (and
 * 9.5-10.5:1 in dark), with the hue kept.
 */
const ACCENTS = [
  { hue: "var(--accent)", text: "color-mix(in oklab, var(--accent-text) 85%, var(--fg))" },
  { hue: "var(--accent-2)", text: "color-mix(in oklab, var(--accent-2-text) 85%, var(--fg))" },
  { hue: "var(--accent-3)", text: "color-mix(in oklab, var(--accent-3-text) 85%, var(--fg))" },
] as const;

/** A tile's colour, and the colour of the monogram's letters on it. */
export type TokenHue = (typeof ACCENTS)[number];

/** One of the accent tokens, picked from the address, so a token keeps its colour and letter case doesn't matter. */
export function tokenHue(address: string): TokenHue {
  let h = 0;
  for (const ch of address.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return ACCENTS[h % ACCENTS.length];
}
