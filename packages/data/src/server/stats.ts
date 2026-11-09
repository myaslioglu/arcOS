import type { Firestore } from "firebase-admin/firestore";
import type { NetworkId } from "@arcos/chain";
import type { StatsDoc } from "../docs";
import { statsId } from "../ids";
import { COLLECTIONS } from "../names";

/** stats/{network} as stored, or null before the indexer's Stats step has counted anything. One read, by id: no query, no index. */
export async function readStats(db: Firestore, network: NetworkId): Promise<StatsDoc | null> {
  const snap = await db.collection(COLLECTIONS.stats).doc(statsId(network)).get();
  return snap.exists ? (snap.data() as StatsDoc) : null;
}
