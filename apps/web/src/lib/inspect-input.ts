import type { PublicClient } from "viem";
import { activeNetwork, arcInspectChain, type Address, type InspectChain } from "@arcos/chain";
import {
  blockscoutSource, chainInput, viemReader, type ExplorerApi, type ExtraPool, type InspectInput, type V4PositionIndex, type VerificationSource,
} from "@arcos/inspector";

/** What an inspection may be given besides the chain, the token and the client. */
export type InspectInputOptions = {
  fetchFn?: typeof fetch;
  /** An explorer API to read instead of the chain's public one, with its key (the server's Blockscout PRO API). */
  explorerApi?: ExplorerApi;
  /** The index's pools for this token (indexed-pools.ts), read besides the ones discovery finds. Arc only. */
  extraPools?: ExtraPool[];
  /** When the caller stops waiting (ms since the epoch): the trade check fits its eth_calls inside it. */
  deadlineAt?: number;
  /** The index's positions for the token's v4 pools (indexed-pools.ts): what lp-lock reads who holds the liquidity from. */
  v4Positions?: V4PositionIndex;
  /** The index holds more pools for the token than `extraPools` lists: lp-lock then can't add its liquidity up. */
  extraPoolsTruncated?: boolean;
  /** A second place to ask whether the code that runs is verified (Sourcify, off Arc). */
  verifyFallback?: VerificationSource | null;
  /** Why the explorer is left out on purpose (the daily budget is spent, say): then it isn't read at all. */
  explorerSkipped?: string;
};

/**
 * An inspection of `address` on `chain`. Everything about the chain comes from its registry entry: the pools read, the
 * lockers, the evidence links, the TokenFactory, the native and trade quotes, the PREVRANDAO wording, the verification
 * rule and how its nodes say a call ran out of gas. The report's `network` is the site's.
 */
export function inspectInputFor(chain: InspectChain, address: Address, client: PublicClient, options: InspectInputOptions = {}): InspectInput {
  const { fetchFn = fetch, explorerApi, extraPools, deadlineAt, v4Positions, extraPoolsTruncated, verifyFallback, explorerSkipped } = options;
  const apiUrl = explorerApi?.url ?? chain.explorer.publicApiUrl;
  return {
    address,
    network: activeNetwork(),
    reader: viemReader(client, chain),
    explorer: !explorerSkipped && apiUrl ? blockscoutSource(apiUrl, fetchFn, explorerApi?.apiKey) : null,
    // Evidence links are for people: the chain's Blockscout UI. A token our own TokenFactory made counts as
    // source-verified through the factory (see checkVerified).
    ...chainInput(chain),
    ...(extraPools && extraPools.length > 0 ? { extraPools } : {}),
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
    ...(v4Positions ? { v4Positions } : {}),
    ...(extraPoolsTruncated ? { extraPoolsTruncated } : {}),
    ...(verifyFallback ? { verifyFallback } : {}),
    ...(explorerSkipped ? { explorerSkipped } : {}),
  };
}

/**
 * An inspection of `address` on Arc, the site's own chain on its network (`arcInspectChain`): the browser Inspector and the
 * server both build their Arc input here, exactly as before there were other chains.
 */
export function inspectInput(
  address: Address,
  client: PublicClient,
  fetchFn: typeof fetch = fetch,
  explorerApi?: ExplorerApi,
  extraPools?: ExtraPool[],
  deadlineAt?: number,
  v4Positions?: V4PositionIndex,
  extraPoolsTruncated?: boolean,
): InspectInput {
  return inspectInputFor(arcInspectChain(activeNetwork()), address, client, { fetchFn, explorerApi, extraPools, deadlineAt, v4Positions, extraPoolsTruncated });
}
