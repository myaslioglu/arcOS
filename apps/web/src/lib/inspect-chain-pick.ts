import { INSPECT_CHAINS, activeNetwork, enabledInspectChains, type InspectChain, type InspectChainKey } from "@arcos/chain";
import { parseInspectTarget } from "./inspect-target";

/**
 * Which chain the Inspector reads a token on, for every place a person asks for one in the browser: the Inspector window,
 * the launcher (Ctrl K) and the Terminal. Pure, and safe in the browser: `NEXT_PUBLIC_INSPECT_CHAINS` is a build-time
 * value, the same one the server's routes read.
 *
 * While the site reads Arc alone (the flag unset, and always on the testnet site), each of those places looks and answers
 * exactly as it did before there were other chains: `readsOtherChains()` is how they tell.
 */

/** The chains this site's Inspector reads: Arc first, then each one switched on, in registry order. */
export const siteInspectChains = (): InspectChain[] => enabledInspectChains(activeNetwork());

/** Whether the site reads a chain besides Arc. */
export const readsOtherChains = (): boolean => siteInspectChains().length > 1;

/** The chain `key` names, when this site reads it; null otherwise. */
export const siteChain = (key: InspectChainKey): InspectChain | null => siteInspectChains().find((c) => c.key === key) ?? null;

/** The chain a slug names, as typed in any case, when this site reads it; null otherwise. */
export const siteChainBySlug = (slug: string): InspectChain | null => siteInspectChains().find((c) => c.slug === slug.trim().toLowerCase()) ?? null;

/** A chain's name as the Inspector shows it: "Arc" on both of Arc's networks, else the registry's ("Base", "OP Mainnet"). */
export const chainName = (chain: Pick<InspectChain, "key" | "name">): string => (chain.key === "arc" ? "Arc" : chain.name);

/** The name of the chain `key` names, whether or not this site reads it: for saying it doesn't. */
export const anyChainName = (key: InspectChainKey): string => {
  const known = INSPECT_CHAINS.mainnet.find((c) => c.key === key);
  return known ? chainName(known) : key;
};

/** The params that open the Inspector on `token` on `chain`: Arc's carry the token alone, as they always have. */
export const inspectorParams = (chain: Pick<InspectChain, "key" | "slug">, token: string): Record<string, string> =>
  chain.key === "arc" ? { token } : { chain: chain.slug, token };

/**
 * What a piece of text asks to inspect, resolved against the chains this site reads:
 * - `none`: it names no token (not an address, a known link, or `<chain>:0x…`);
 * - `elsewhere`: it names a token on a chain this site doesn't read (`chain` is that chain's key);
 * - `token`: an address, and the chain the text named, or null when it named none (a bare address).
 */
export type PickedToken =
  | { kind: "none" }
  | { kind: "elsewhere"; chain: InspectChainKey }
  | { kind: "token"; address: string; chain: InspectChain | null };

export function pickToken(text: string): PickedToken {
  const target = parseInspectTarget(text);
  if (!target) return { kind: "none" };
  if (target.chain === null) return { kind: "token", address: target.address, chain: null };
  const chain = siteChain(target.chain);
  return chain ? { kind: "token", address: target.address, chain } : { kind: "elsewhere", chain: target.chain };
}
