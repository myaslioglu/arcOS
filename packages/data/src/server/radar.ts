import type { Firestore } from "firebase-admin/firestore";
import type { NetworkId } from "@arcos/chain";
import type { IndexerDoc, RadarFeedDoc } from "../docs";
import { assertNetwork, radarFeedId } from "../ids";
import { COLLECTIONS, type RadarFeedFilter } from "../names";
import type { TimestampLike } from "../timestamps";

/** One Radar page as stored, and when the indexer last finished a run: what GET /api/radar answers from. */
export type RadarFeedRead = {
  feed: RadarFeedDoc | null;
  indexer: { lastRunAt: TimestampLike | null } | null;
};

/**
 * Two reads. Feed null before the indexer's first run writes it. The indexer doc is read for `lastRunAt` alone (the
 * site shows when the index last ran), never handed on whole. No query and no index: both are reads by id, in one
 * `getAll`. A filter that isn't one of the four rejects with a DataError ("radar-filter").
 */
export async function readRadarFeed(db: Firestore, network: NetworkId, filter: RadarFeedFilter): Promise<RadarFeedRead> {
  const [feedSnap, indexerSnap] = await db.getAll(
    db.collection(COLLECTIONS.radarFeed).doc(radarFeedId(network, filter)),
    db.collection(COLLECTIONS.indexer).doc(assertNetwork(network)),
  );
  const feed = feedSnap?.exists ? (feedSnap.data() as RadarFeedDoc) : null;
  const indexer = indexerSnap?.exists ? { lastRunAt: (indexerSnap.data() as Partial<IndexerDoc>).lastRunAt ?? null } : null;
  return { feed, indexer };
}
