import { getAddress, isAddress } from "viem";
import { CHAINS, INSPECT_CHAINS, type Address, type InspectChainKey } from "@arcos/chain";

/**
 * What a token to inspect was given as: its address, and the chain the text named, or null when it named none (a bare
 * address, which the routes read as Arc and the launcher offers on every chain).
 */
export type InspectTarget = { address: Address; chain: InspectChainKey | null };

/** Chain prefixes before `:0x…`: the registry's slugs, and the ERC-3770 short names of the same chains. */
const PREFIXES: Record<string, InspectChainKey> = {
  ...Object.fromEntries(INSPECT_CHAINS.mainnet.map((c) => [c.slug, c.key])),
  eth: "ethereum",
  arb1: "arbitrum",
  oeth: "optimism",
};

/** CAIP-2's `eip155:<chain id>`: every chain id the registry knows, Arc's two networks included. */
const CHAIN_IDS: Record<number, InspectChainKey> = {
  ...Object.fromEntries(INSPECT_CHAINS.mainnet.map((c) => [c.chainId, c.key])),
  [CHAINS.mainnet.id]: "arc",
  [CHAINS.testnet.id]: "arc",
};

/** Explorer hosts whose `/token/0x…` and `/address/0x…` pages name a token on one chain. */
const EXPLORERS: Record<string, InspectChainKey> = {
  "etherscan.io": "ethereum",
  "basescan.org": "base",
  "arbiscan.io": "arbitrum",
  "optimistic.etherscan.io": "optimism",
  "eth.blockscout.com": "ethereum",
  "base.blockscout.com": "base",
  "arbitrum.blockscout.com": "arbitrum",
  "optimism.blockscout.com": "optimism",
  "explorer.arc.io": "arc",
  "explorer.testnet.arc.io": "arc",
};

/** Uniswap's web app names a chain in `/explore/tokens/<chain>/0x…` the way the registry's slugs do. */
const UNISWAP_CHAINS: Record<string, InspectChainKey> = { ethereum: "ethereum", base: "base", arbitrum: "arbitrum", optimism: "optimism" };

/** This site's own hosts, whose `/t/…` and `/badge/…` links name a report. */
const OWN_HOSTS = new Set(["4rcos.com", "testnet.4rcos.com"]);

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** A table's own entry for `key`, never one it inherits: "constructor:0x…" or a host named "toString" names no chain. */
const own = <K extends string | number>(table: Record<K, InspectChainKey>, key: K): InspectChainKey | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined;

const asAddress = (text: string | undefined): Address | null =>
  text !== undefined && ADDRESS.test(text) && isAddress(text, { strict: false }) ? getAddress(text) : null;

/** `text` as a URL, with "https://" put in front of a bare host and path ("basescan.org/token/0x…"); null otherwise. */
function asUrl(text: string): URL | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : /^[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(text) ? `https://${text}` : null;
  if (!withScheme) return null;
  try {
    const url = new URL(withScheme);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * The token a piece of text names, for every place a person gives one: the routes, the Inspector window, the launcher
 * (Ctrl K) and the Terminal. It reads:
 * - a bare address, naming no chain;
 * - `<chain>:0x…`, by the registry's slug (`base:0x…`) or the chain's ERC-3770 short name (`eth:`, `arb1:`, `oeth:`);
 * - CAIP-10's `eip155:<chain id>:0x…`;
 * - a token or address page on an explorer: Etherscan, Basescan, Arbiscan, Optimistic Etherscan, the chains' Blockscout
 *   instances and explorer.arc.io;
 * - Uniswap's `app.uniswap.org/explore/tokens/<chain>/0x…`;
 * - this site's own `/t/…` and `/badge/…` links.
 * Not DEX Screener: its links name pairs, not tokens. Anything else is null. The chain is whichever the text named,
 * switched on or not: the caller decides what to do with one this site doesn't read.
 */
export function parseInspectTarget(input: string): InspectTarget | null {
  const text = input.trim();
  const bare = asAddress(text);
  if (bare) return { address: bare, chain: null };

  const caip = /^eip155:(\d{1,12}):(0x[0-9a-fA-F]{40})$/i.exec(text);
  if (caip) {
    const chain = own(CHAIN_IDS, Number(caip[1]));
    const address = asAddress(caip[2]);
    return chain && address ? { address, chain } : null;
  }
  const prefixed = /^([a-z0-9]{2,16}):(0x[0-9a-fA-F]{40})$/i.exec(text);
  if (prefixed) {
    const chain = own(PREFIXES, prefixed[1]!.toLowerCase());
    const address = asAddress(prefixed[2]);
    return chain && address ? { address, chain } : null;
  }

  const url = asUrl(text);
  if (!url) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const parts = url.pathname.split("/").filter(Boolean);

  const explorer = own(EXPLORERS, host);
  if (explorer) {
    const at = parts.findIndex((p) => p === "token" || p === "address");
    const address = at >= 0 ? asAddress(parts[at + 1]) : null;
    return address ? { address, chain: explorer } : null;
  }
  if (host === "app.uniswap.org" && parts[0] === "explore" && parts[1] === "tokens") {
    const chain = own(UNISWAP_CHAINS, parts[2]?.toLowerCase() ?? "");
    const address = asAddress(parts[3]);
    return chain && address ? { address, chain } : null;
  }
  if (OWN_HOSTS.has(host) && (parts[0] === "t" || parts[0] === "badge")) {
    if (parts.length === 2) {
      const address = asAddress(parts[1]);
      return address ? { address, chain: "arc" } : null;
    }
    if (parts.length === 3) {
      const chain = INSPECT_CHAINS.mainnet.find((c) => c.slug === parts[1])?.key;
      const address = asAddress(parts[2]);
      return chain && address ? { address, chain } : null;
    }
  }
  return null;
}
