import type { PublicClient } from "viem";
import { ARCOS, DEX, KNOWN_LOCKERS, activeChain, activeNetwork, type Address } from "@arcos/chain";
import { blockscoutSource, viemReader, type InspectInput } from "@arcos/inspector";

/** An explorer API to read instead of the chain's public one, with the key it needs. */
export type ExplorerApi = { url: string; apiKey: string };

/**
 * Blockscout's PRO API for `chainId`, or undefined without a key. Arc mainnet's public explorer answers browsers but
 * refuses server requests (a Cloudflare bot check), so the server reads the same Blockscout data from here instead.
 */
export function proExplorerApi(chainId: number, apiKey: string | undefined): ExplorerApi | undefined {
  const key = apiKey?.trim();
  return key ? { url: `https://api.blockscout.com/${chainId}/api/v2`, apiKey: key } : undefined;
}

export function inspectInput(
  address: Address,
  client: PublicClient,
  fetchFn: typeof fetch = fetch,
  explorerApi?: ExplorerApi,
): InspectInput {
  const network = activeNetwork();
  const explorer = activeChain().blockExplorers?.default;
  const apiUrl = explorerApi?.url ?? explorer?.apiUrl;
  return {
    address,
    network,
    reader: viemReader(client),
    explorer: apiUrl ? blockscoutSource(apiUrl, fetchFn, explorerApi?.apiKey) : null,
    dex: DEX[network],
    knownLockers: KNOWN_LOCKERS[network],
    // Evidence links are for people, and the public explorer answers browsers.
    explorerBase: explorer?.url ?? "",
    // A token our own TokenFactory made counts as source-verified through the factory (see checkVerified).
    arcosTokenFactory: ARCOS[network]?.tokenFactory ?? null,
  };
}
