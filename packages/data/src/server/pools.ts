import type { Firestore } from "firebase-admin/firestore";
import type { NetworkId } from "@arcos/chain";
import type { PoolDoc } from "../docs";
import { normalizeAddress, assertNetwork } from "../ids";
import { COLLECTIONS, INDEXED_POOLS_LIMIT } from "../names";

/**
 * A token's indexed pools on `network`, at most `limit`, in no promised order. Two equality filters, which Firestore
 * serves from its single-field indexes: no composite index is needed. One read per pool returned (one when there is
 * none).
 */
export async function indexedPools(db: Firestore, network: NetworkId, token: string, limit = INDEXED_POOLS_LIMIT): Promise<PoolDoc[]> {
  const snap = await db
    .collection(COLLECTIONS.pools)
    .where("network", "==", assertNetwork(network))
    .where("token", "==", normalizeAddress(token))
    .limit(limit)
    .get();
  return snap.docs.map((doc) => doc.data() as PoolDoc);
}
