import type { Firestore } from "firebase-admin/firestore";
import type { NetworkId } from "@arcos/chain";
import type { PositionDoc, PositionKey, PositionsIndexDoc } from "../docs";
import { assertNetwork, normalizePoolId, positionsIndexId } from "../ids";
import { COLLECTIONS, INDEXED_POSITIONS_LIMIT, INDEXED_POSITIONS_TOTAL } from "../names";
import { positionKey } from "../positions";

/** A pool's positions as the index holds them. `truncated`: the pool has more than `positions` lists. */
export type IndexedPositions = {
  positions: PositionKey[];
  truncated: boolean;
  /** The last block the index has handled, or null before its first run: a position opened after it isn't listed. */
  cursor: number | null;
};

/** The position index's cursor: the last block whose `ModifyLiquidity` logs are all stored, or null before the first run. */
export async function readPositionsCursor(db: Firestore, network: NetworkId): Promise<number | null> {
  const snap = await db.collection(COLLECTIONS.positionsIndex).doc(positionsIndexId(network)).get();
  const block = snap.exists ? (snap.data() as PositionsIndexDoc).block : null;
  return typeof block === "number" && Number.isSafeInteger(block) ? block : null;
}

async function poolPositions(db: Firestore, network: NetworkId, poolId: string, limit: number): Promise<{ positions: PositionKey[]; truncated: boolean }> {
  // Two equality filters, which Firestore serves from its single-field indexes: no composite index. One more than the
  // limit is asked for, which is how "there are more" is known without a count.
  const snap = await db
    .collection(COLLECTIONS.positions)
    .where("network", "==", assertNetwork(network))
    .where("poolId", "==", normalizePoolId(poolId))
    .limit(limit + 1)
    .get();
  const docs = snap.docs.slice(0, limit).map((doc) => positionKey(doc.data() as PositionDoc));
  return { positions: docs, truncated: snap.size > limit };
}

/**
 * The positions the index holds for one Uniswap v4 pool, at most `limit`, in no promised order, with the index's cursor.
 * The cursor is read first: the indexer stores a window's positions before it moves the cursor, so every position
 * opened at or before the cursor returned is in the list (unless `truncated`). One read per position, at least one.
 */
export async function indexedPositions(db: Firestore, network: NetworkId, poolId: string, limit = INDEXED_POSITIONS_LIMIT): Promise<IndexedPositions> {
  const cursor = await readPositionsCursor(db, network);
  return { ...(await poolPositions(db, network, poolId, limit)), cursor };
}

/** The positions of several pools under one cursor, keyed by pool id (lowercase): what an inspection's `v4Positions` takes. */
export type TokenPositions = { cursor: number; pools: Record<string, { positions: PositionKey[]; truncated: boolean }> };

/**
 * The index's positions for each of `poolIds` (a token's v4 pools), or null before the index's first run. Every pool
 * asked for has an entry, an empty one when the index holds nothing for it. At most `limit` positions a pool and `total`
 * over all of them: once the total is reached, the pools left that hold any are answered `truncated` with no list. The
 * cursor is read first, as in `indexedPositions`. One query a pool, all at once.
 */
export async function indexedPositionsFor(
  db: Firestore,
  network: NetworkId,
  poolIds: readonly string[],
  limit = INDEXED_POSITIONS_LIMIT,
  total = INDEXED_POSITIONS_TOTAL,
): Promise<TokenPositions | null> {
  const cursor = await readPositionsCursor(db, network);
  if (cursor === null) return null;
  const ids = [...new Set(poolIds.map((id) => normalizePoolId(id)))];
  const found = await Promise.all(ids.map((id) => poolPositions(db, network, id, limit)));
  const pools: TokenPositions["pools"] = {};
  let left = total;
  ids.forEach((id, i) => {
    const entry = found[i]!;
    if (entry.positions.length > left) pools[id] = { positions: [], truncated: true };
    else {
      pools[id] = entry;
      left -= entry.positions.length;
    }
  });
  return { cursor, pools };
}
