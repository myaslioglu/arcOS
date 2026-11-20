import type { Firestore } from "firebase-admin/firestore";
import type { NetworkId } from "@arcos/chain";
import type { PoolDoc } from "../docs";
import { normalizeAddress, assertNetwork } from "../ids";
import { COLLECTIONS, INDEXED_POOLS_LIMIT } from "../names";

/** A token's indexed pools, and whether the index holds more of them than `pools` lists. */
export type IndexedPoolList = { pools: PoolDoc[]; truncated: boolean };

/**
 * A token's indexed pools on `network`, at most `limit`, in no promised order (Firestore's: by doc id), and whether there
 * are more. One more than the limit is asked for, which is how "there are more" is known without a count: a list that
 * was cut short must say so, since a pool it left out is a pool nobody reads. Two equality filters, which Firestore
 * serves from its single-field indexes: no composite index is needed. One read per pool returned (one when there is none).
 */
export async function indexedPoolList(db: Firestore, network: NetworkId, token: string, limit = INDEXED_POOLS_LIMIT): Promise<IndexedPoolList> {
  const snap = await db
    .collection(COLLECTIONS.pools)
    .where("network", "==", assertNetwork(network))
    .where("token", "==", normalizeAddress(token))
    .limit(limit + 1)
    .get();
  return { pools: snap.docs.slice(0, limit).map((doc) => doc.data() as PoolDoc), truncated: snap.size > limit };
}

/** The pools alone (see `indexedPoolList`): for a caller that only lists them. */
export async function indexedPools(db: Firestore, network: NetworkId, token: string, limit = INDEXED_POOLS_LIMIT): Promise<PoolDoc[]> {
  return (await indexedPoolList(db, network, token, limit)).pools;
}
