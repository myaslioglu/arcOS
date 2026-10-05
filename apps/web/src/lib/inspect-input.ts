import type { PublicClient } from "viem";
import { ARCOS, DEX, KNOWN_LOCKERS, activeChain, activeNetwork, type Address } from "@arcos/chain";
import { blockscoutSource, viemReader, type ExplorerApi, type ExtraPool, type InspectInput } from "@arcos/inspector";

export function inspectInput(
  address: Address,
  client: PublicClient,
  fetchFn: typeof fetch = fetch,
  explorerApi?: ExplorerApi,
  /** The index's pools for this token (indexed-pools.ts), read besides the ones discovery finds. */
  extraPools?: ExtraPool[],
  /** When the caller stops waiting (ms since the epoch): the trade check fits its eth_calls inside it. */
  deadlineAt?: number,
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
    ...(extraPools && extraPools.length > 0 ? { extraPools } : {}),
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
  };
}
