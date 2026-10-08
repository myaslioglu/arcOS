/** Known launchpads: the address that creates their tokens, lowercased, to the name Radar shows as a badge. Matched
 * against the creator the index recorded, which today is the caller of the 4rc.OS TokenFactory; a token first seen through
 * a pool has no recorded creator. Empty until a launchpad's address is confirmed on-chain. */
export const LAUNCHPADS: Readonly<Record<string, string>> = {};

/** The launchpad a token's creator names, or null: unknown creators, and anything that isn't an address, give null. */
export function launchpadOf(creator: string | null | undefined, map: Readonly<Record<string, string>> = LAUNCHPADS): string | null {
  if (typeof creator !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(creator)) return null;
  const key = creator.toLowerCase();
  return Object.hasOwn(map, key) ? map[key]! : null;
}
