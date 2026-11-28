import { CHAINS, INSPECT_CHAINS, activeNetwork, enabledInspectChains, type InspectChain, type InspectChainKey, type NetworkId } from "@arcos/chain";
import { parseInspectTarget } from "./inspect-target";

/**
 * Which chain the Inspector reads a token on, for every place a person asks for one in the browser: the Inspector window,
 * the launcher (Ctrl K) and the Terminal. Pure, and safe in the browser: `NEXT_PUBLIC_INSPECT_CHAINS` is a build-time
 * value, the same one the server's routes read.
 *
 * While the site reads Arc alone (the flag unset, and always on the testnet site), `readsOtherChains()` is false and none
 * of those places reads a link or `<chain>:0x…`: each takes a pasted address, as before there were other chains. Three
 * things differ from then. The Terminal refuses a chain other than Arc named after the address (`inspect 0x… base`),
 * which it used to ignore, opening the address on Arc. An Inspector window opened with a `chain` other than Arc's
 * (`#app:inspector?chain=base&token=0x…`) says it doesn't read that chain, where it used to inspect the address on Arc.
 * And the window's `inspect_run` event carries the chain it read ("arc"), for the counts alone. Ctrl K is unchanged.
 */

/** The chains this site's Inspector reads: Arc first, then each one switched on, in registry order. */
export const siteInspectChains = (): InspectChain[] => enabledInspectChains(activeNetwork());

/** Whether the site reads a chain besides Arc. */
export const readsOtherChains = (): boolean => siteInspectChains().length > 1;

/** A slug as typed: in any case, with spaces around it. */
const slugOf = (text: string): string => text.trim().toLowerCase();

/** The registry's chain keys: the only chains a name or a link is taken to name. */
const KEYS: ReadonlySet<string> = new Set(INSPECT_CHAINS.mainnet.map((c) => c.key));

/** Whether `value` is one of the registry's chain keys, never a name only an object has (`constructor`). */
const isChainKey = (value: unknown): value is InspectChainKey => typeof value === "string" && KEYS.has(value);

/** The chain `key` names, when this site reads it; null otherwise. */
export const siteChain = (key: InspectChainKey): InspectChain | null => siteInspectChains().find((c) => c.key === key) ?? null;

/** The chain a slug names, as typed in any case, when this site reads it; null otherwise. */
export const siteChainBySlug = (slug: string): InspectChain | null => siteInspectChains().find((c) => c.slug === slugOf(slug)) ?? null;

/** A chain's name as the Inspector shows it: "Arc" on both of Arc's networks, else the registry's ("Base", "OP Mainnet"). */
export const chainName = (chain: Pick<InspectChain, "key" | "name">): string => (chain.key === "arc" ? "Arc" : chain.name);

/** The name of the chain `key` names, whether or not this site reads it: for saying it doesn't. */
export const anyChainName = (key: InspectChainKey): string => {
  const known = INSPECT_CHAINS.mainnet.find((c) => c.key === key);
  return known ? chainName(known) : key;
};

/** What the Inspector says of a chain, by its name, that this site doesn't read. */
export const notReadHere = (name: string): string => `Inspector doesn't read ${name} on this site.`;

/** Any address, to read a name the way `<name>:0x…` reads it. */
const ANY_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * The chain `name` names as the prefix of `<name>:0x…` does: a registry slug ("base") or the chain's ERC-3770 short name
 * ("eth"), in any case, whether or not this site reads that chain; null for any other name. It asks `parseInspectTarget`
 * itself, so the Terminal's `inspect 0x… <name>` takes exactly the names `inspect <name>:0x…` does.
 */
export function chainNamed(name: string): InspectChainKey | null {
  // A name alone, in the shape a prefix has: never text the parser could read as a link instead.
  if (!/^[a-z0-9]{2,16}$/i.test(name)) return null;
  const chain = parseInspectTarget(`${name}:${ANY_ADDRESS}`)?.chain;
  return isChainKey(chain) ? chain : null;
}

/** The params that open the Inspector on `token` on `chain`: Arc's carry the token alone, as they always have. */
export const inspectorParams = (chain: Pick<InspectChain, "key" | "slug">, token: string): Record<string, string> =>
  chain.key === "arc" ? { token } : { chain: chain.slug, token };

/** Arc's two networks by name, for saying the site doesn't read the other one. */
const ARC_NETWORKS: Record<NetworkId, string> = { mainnet: "Arc mainnet", testnet: "Arc Testnet" };

/** The hosts whose links inspect-target.ts reads as Arc's, by network: this site on each, and each one's explorer. */
const ARC_HOSTS: ReadonlyMap<string, NetworkId> = new Map<string, NetworkId>([
  ["4rcos.com", "mainnet"],
  ["explorer.arc.io", "mainnet"],
  ["testnet.4rcos.com", "testnet"],
  ["explorer.testnet.arc.io", "testnet"],
]);

/**
 * Which of Arc's networks `text` names, when it names one: by its chain id in `eip155:<chain id>:0x…`, or by its host in
 * a link, read as inspect-target.ts reads one (lower case, without "www.", and "https://" before a bare host and path).
 * `arc:0x…` and a bare address name neither.
 */
function arcNetworkOf(text: string): NetworkId | null {
  const t = text.trim();
  const caip = /^eip155:(\d{1,12}):/i.exec(t);
  if (caip) {
    const id = Number(caip[1]);
    return id === CHAINS.mainnet.id ? "mainnet" : id === CHAINS.testnet.id ? "testnet" : null;
  }
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`);
    return ARC_HOSTS.get(url.hostname.toLowerCase().replace(/^www\./, "")) ?? null;
  } catch {
    return null;
  }
}

/**
 * What a piece of text asks to inspect, resolved against the chains this site reads:
 * - `none`: it names no token (not an address, a known link, or `<chain>:0x…`);
 * - `elsewhere`: it names a token on a chain this site doesn't read, another chain or the other one of Arc's networks
 *   (`name` is that chain's, as the Inspector says it: "Base", "Arc Testnet");
 * - `token`: an address, and the chain the text named, or null when it named none (a bare address).
 */
export type PickedToken =
  | { kind: "none" }
  | { kind: "elsewhere"; name: string }
  | { kind: "token"; address: string; chain: InspectChain | null };

export function pickToken(text: string): PickedToken {
  const target = parseInspectTarget(text);
  if (!target) return { kind: "none" };
  if (target.chain === null) return { kind: "token", address: target.address, chain: null };
  // Only the registry's chains are named: `constructor:0x…` names none.
  if (!isChainKey(target.chain)) return { kind: "none" };
  // The parser reads both of Arc's networks as "arc". A link or chain id of the network this site isn't on names a token
  // the site doesn't read, never the same address on this network's Arc.
  const network = target.chain === "arc" ? arcNetworkOf(text) : null;
  if (network !== null && network !== activeNetwork()) return { kind: "elsewhere", name: ARC_NETWORKS[network] };
  const chain = siteChain(target.chain);
  return chain ? { kind: "token", address: target.address, chain } : { kind: "elsewhere", name: anyChainName(target.chain) };
}
