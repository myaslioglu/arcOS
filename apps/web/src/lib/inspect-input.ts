import type { PublicClient } from "viem";
import { activeNetwork, arcInspectChain, type Address } from "@arcos/chain";
import { blockscoutSource, chainInput, viemReader, type ExplorerApi, type ExtraPool, type InspectInput } from "@arcos/inspector";

/**
 * An inspection of `address` on Arc, the site's own chain on its network (`arcInspectChain`): the browser Inspector and the
 * server both build their input here. Everything about the chain comes from its registry entry: the pools read, the
 * lockers, the evidence links, the TokenFactory, the native and trade quotes, the PREVRANDAO wording and how its nodes say
 * a call ran out of gas.
 */
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
  const chain = arcInspectChain(network);
  const apiUrl = explorerApi?.url ?? chain.explorer.publicApiUrl;
  return {
    address,
    network,
    reader: viemReader(client, chain),
    explorer: apiUrl ? blockscoutSource(apiUrl, fetchFn, explorerApi?.apiKey) : null,
    // Evidence links are for people, and the public explorer answers browsers. A token our own TokenFactory made counts
    // as source-verified through the factory (see checkVerified).
    ...chainInput(chain),
    ...(extraPools && extraPools.length > 0 ? { extraPools } : {}),
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
  };
}
