import type { Firestore } from "firebase-admin/firestore";
import type { NetworkId } from "@arcos/chain";
import type { IndexerDoc, PositionDoc, PositionKey, PositionsIndexDoc } from "../docs";
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

/**
 * The position index's cursor: the last block whose `ModifyLiquidity` logs are all stored. Null before the first run, and
 * null while the step is switched off (`indexer/{network}.positions === false`): an index nobody is keeping up is not
 * served, so its readers fall back at once instead of waiting for the cursor to go stale. Two reads, by id.
 */
export async function readPositionsCursor(db: Firestore, network: NetworkId): Promise<number | null> {
  const [controls, cursor] = await db.getAll(
    db.collection(COLLECTIONS.indexer).doc(assertNetwork(network)),
    db.collection(COLLECTIONS.positionsIndex).doc(positionsIndexId(network)),
  );
  if (controls!.exists && (controls!.data() as Pick<IndexerDoc, "positions">).positions === false) return null;
  const block = cursor!.exists ? (cursor!.data() as PositionsIndexDoc).block : null;
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
 * The positions the index holds for one Uniswap v4 pool, at most `limit`, in no promised order, with the index's cursor
 * (null before its first run or while it is switched off: the list is then empty and says nothing). The cursor is read
 * first: the indexer stores a window's positions before it moves the cursor, so every position opened at or before the
 * cursor returned is in the list (unless `truncated`). One read per position, at least one.
 */
export async function indexedPositions(db: Firestore, network: NetworkId, poolId: string, limit = INDEXED_POSITIONS_LIMIT): Promise<IndexedPositions> {
  const cursor = await readPositionsCursor(db, network);
  if (cursor === null) return { positions: [], truncated: false, cursor };
  return { ...(await poolPositions(db, network, poolId, limit)), cursor };
}

/** The positions of several pools under one cursor, keyed by pool id (lowercase): what an inspection's `v4Positions` takes. */
export type TokenPositions = { cursor: number; pools: Record<string, { positions: PositionKey[]; truncated: boolean }> };

/**
 * The index's positions for each of `poolIds` (a token's v4 pools as pools/ lists them), or null before the index's
 * first run and while it is switched off. Every pool asked for has an entry, an empty one when the index holds nothing
 * for it. The reads are bounded by `total`, whatever the pools hold: one pool after another, each asked for no more
 * than what is left of the total (and no more than `limit`), plus one to know whether there are more; a pool over its
 * share is `truncated` and its list left out, and from then on, as once nothing is left of the total, no further pool
 * is read at all (each is `truncated`: nobody looked). So at most `total` + one per pool docs are read. The cursor is read first, as in
 * `indexedPositions`.
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
  const pools: TokenPositions["pools"] = {};
  let left = total;
  for (const id of new Set(poolIds.map((poolId) => normalizePoolId(poolId)))) {
    if (left <= 0) {
      pools[id] = { positions: [], truncated: true };
      continue;
    }
    const entry = await poolPositions(db, network, id, Math.min(limit, left));
    if (entry.truncated) {
      // The answer can't be relied on any more, whatever the other pools hold: nothing further is read.
      pools[id] = { positions: [], truncated: true };
      left = 0;
    } else {
      pools[id] = entry;
      left -= entry.positions.length;
    }
  }
  return { cursor, pools };
}
