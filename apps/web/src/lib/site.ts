import type { NetworkId } from "@arcos/chain";

/**
 * Public repository URL, in one place. Empty until the repo is made public — every
 * consumer must check for that and skip rendering the link rather than pointing at a
 * dead URL.
 */
export const REPO_URL = "https://github.com/myaslioglu/arcOS";

/** The title every page has unless it sets its own: the testnet site's names it, so a tab or a bookmark tells them apart. */
export function siteTitle(network: NetworkId): string {
  return network === "testnet" ? "4rc.OS Testnet" : "4rc.OS";
}

/** The label the shell shows beside the brand. Only the testnet site (https://testnet.4rcos.com) has one. */
export function networkBadge(network: NetworkId): string | undefined {
  return network === "testnet" ? "Testnet" : undefined;
}

/**
 * The testnet site asks search engines not to index or follow it, so a search for 4rc.OS finds the mainnet site. Mainnet
 * sets no robots rule of its own (indexable, Next's default). Pages that set their own robots, such as the token pages,
 * replace this one, and say noindex on both networks.
 */
export function siteRobots(network: NetworkId): { index: false; follow: false } | undefined {
  return network === "testnet" ? { index: false, follow: false } : undefined;
}

/**
 * The same rule as a header on every answer (next.config.ts), which covers what has no HTML to carry a meta tag: the
 * API routes, the icons, the social cards. No robots.txt: a crawler kept out by one never reads the noindex.
 */
export function robotsHeaders(network: NetworkId): { key: string; value: string }[] {
  return network === "testnet" ? [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] : [];
}
