import type { Firestore } from "firebase-admin/firestore";
import type { NetworkId } from "@arcos/chain";
import type { IndexerDoc, PositionDoc, PositionKey, PositionsIndexDoc, PositionsProgress } from "../docs";
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
  return (await readPositionsState(db, network))?.cursor ?? null;
}

const blockNumber = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** The step's progress fields off its cursor doc, each kept only when it is a whole, non-negative number. */
export function positionsProgress(doc: Partial<PositionsIndexDoc>): PositionsProgress {
  const { span, ceiling, ceilingUntil, attempt } = doc;
  return {
    ...(blockNumber(span) ? { span } : {}),
    ...(blockNumber(ceiling) ? { ceiling } : {}),
    ...(blockNumber(ceilingUntil) ? { ceilingUntil } : {}),
    ...(typeof attempt === "object" && attempt !== null && blockNumber(attempt.from) && blockNumber(attempt.width) ? { attempt: { from: attempt.from, width: attempt.width } } : {}),
  };
}

/** The cursor (see `readPositionsCursor`: null before the first run and while switched off) with the step's progress. */
async function readPositionsState(db: Firestore, network: NetworkId): Promise<{ cursor: number; progress: PositionsProgress } | null> {
  const [controls, cursor] = await db.getAll(
    db.collection(COLLECTIONS.indexer).doc(assertNetwork(network)),
    db.collection(COLLECTIONS.positionsIndex).doc(positionsIndexId(network)),
  );
  if (controls!.exists && (controls!.data() as Pick<IndexerDoc, "positions">).positions === false) return null;
  if (!cursor!.exists) return null;
  const doc = cursor!.data() as PositionsIndexDoc;
  return typeof doc.block === "number" && Number.isSafeInteger(doc.block) ? { cursor: doc.block, progress: positionsProgress(doc) } : null;
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
export type TokenPositions = { cursor: number; pools: Record<string, { positions: PositionKey[]; truncated: boolean }>; progress?: PositionsProgress };

/** How many pools' positions are asked for at once. */
const POOLS_AT_ONCE = 4;

/**
 * The index's positions for each of `poolIds` (a token's v4 pools as pools/ lists them), or null before the index's
 * first run and while it is switched off. Every pool asked for has an entry, an empty one when the index holds nothing
 * for it. The reads are bounded by `total`, whatever the pools hold: the pools are read four at a time, in order, each
 * asked for no more than what was left of the total when its four began (and no more than `limit`), plus one to know
 * whether there are more. They are then counted in order: a pool over its share, or the one that takes the count past
 * the total, is `truncated` and its list left out, and from then on no further pool is counted or read at all (each is
 * `truncated`: nobody looked). So at most four times what is left is read in any one round, and never more than
 * `total` + 3 x `limit` + one per pool docs in all. The cursor is read first, as in `indexedPositions`.
 */
export async function indexedPositionsFor(
  db: Firestore,
  network: NetworkId,
  poolIds: readonly string[],
  limit = INDEXED_POSITIONS_LIMIT,
  total = INDEXED_POSITIONS_TOTAL,
): Promise<TokenPositions | null> {
  const state = await readPositionsState(db, network);
  if (state === null) return null;
  const { cursor, progress } = state;
  const pools: TokenPositions["pools"] = {};
  const ids = [...new Set(poolIds.map((poolId) => normalizePoolId(poolId)))];
  let left = total;
  for (let i = 0; i < ids.length; i += POOLS_AT_ONCE) {
    const round = ids.slice(i, i + POOLS_AT_ONCE);
    const ask = Math.min(limit, left);
    const entries = left > 0 ? await Promise.all(round.map((id) => poolPositions(db, network, id, ask))) : [];
    round.forEach((id, n) => {
      const entry = entries[n];
      if (left <= 0 || !entry || entry.truncated || entry.positions.length > left) {
        // The answer can't be relied on any more, whatever the other pools hold: nothing further is counted or read.
        pools[id] = { positions: [], truncated: true };
        left = 0;
      } else {
        pools[id] = entry;
        left -= entry.positions.length;
      }
    });
  }
  // The step's progress rides along, when there is any to show: how wide it reads and whether it is narrowing.
  return { cursor, pools, ...(Object.keys(progress).length > 0 ? { progress } : {}) };
}
