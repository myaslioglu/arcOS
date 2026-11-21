import { FieldValue, Timestamp, type DocumentReference, type Firestore } from "firebase-admin/firestore";
import type { NetworkId } from "@arcos/chain";
import { COLLECTIONS, poolId, poolToDoc, positionDoc, positionId, positionsIndexId, type PoolDoc, type PositionDoc, type PositionsIndexDoc } from "@arcos/data";
import { positionFromLog, type V4PositionKey } from "@arcos/inspector";
import { decodeLogs, sourcesFor, type RawLog } from "./events";
import { selectPool } from "./pools";

// Every Firestore read and write of the position index. A position is one doc under the PoolManager's own key for it
// (positions/), written once; the cursor is one doc (positionsIndex/{network}), moved after a window's positions are in.
// The step also completes pools/: a v4 pool created before the main indexer's first block has no doc there, and an
// inspection finds a hooked or odd-fee pool only through one.

export const positionsIndexRef = (db: Firestore, network: NetworkId) => db.collection(COLLECTIONS.positionsIndex).doc(positionsIndexId(network));

/** A position a window's logs named, with the block of the first log that did. */
export type SeenPosition = { poolId: string; key: V4PositionKey; block: number };

/**
 * The positions `logs` name, each once, with the lowest block that named it. A log outside [from, to], one the node marks
 * removed, or one that isn't a well-formed `ModifyLiquidity` is left out: the filter asked for that event of that
 * contract, so anything else is not the PoolManager's.
 */
export function decodePositionLogs(logs: readonly RawLog[], poolManager: string, window: { from: number; to: number }): SeenPosition[] {
  const seen = new Map<string, SeenPosition>();
  for (const log of logs) {
    if (log.removed || log.address.toLowerCase() !== poolManager.toLowerCase()) continue;
    const block = Number(BigInt(log.blockNumber));
    if (block < window.from || block > window.to) continue;
    const found = positionFromLog(log);
    if (!found || found.key.tickLower >= found.key.tickUpper) continue;
    const id = `${found.poolId}:${found.key.owner}:${found.key.tickLower}:${found.key.tickUpper}:${found.key.salt}`;
    const before = seen.get(id);
    if (!before || block < before.block) seen.set(id, { ...found, block });
  }
  return [...seen.values()];
}

/**
 * The v4 pools `logs` announce (the PoolManager's `Initialize`) that the pool index keeps, as pool docs: the ones
 * `selectPool` keeps for the main indexer too, a quote currency on exactly one side. Each once, and only from [from, to].
 */
export function decodePoolLogs(logs: readonly RawLog[], network: NetworkId, window: { from: number; to: number }): PoolDoc[] {
  const sources = sourcesFor(network).filter((s) => s.kind === "v4");
  const pools = new Map<string, PoolDoc>();
  for (const sighting of decodeLogs(logs, sources)) {
    if (sighting.kind !== "pool" || sighting.block < window.from || sighting.block > window.to) continue;
    const selected = selectPool(sighting, network);
    if (selected && !pools.has(selected.pool.poolId)) pools.set(selected.pool.poolId, poolToDoc(selected.pool));
  }
  return [...pools.values()];
}

/**
 * The index's cursor doc, created on the first run one block before `fromBlock` (so that block's logs are read) with
 * `head` at the run's `tip`. An existing doc's `head` is raised to `tip`. Two first runs can't both create it.
 */
export async function ensurePositionsIndex(db: Firestore, network: NetworkId, fromBlock: number, now: number, tip: number): Promise<PositionsIndexDoc> {
  const ref = positionsIndexRef(db, network);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const stored = snap.data() as PositionsIndexDoc;
      if ((stored.head ?? 0) >= tip) return stored;
      tx.update(ref, { head: tip });
      return { ...stored, head: tip };
    }
    const doc: PositionsIndexDoc = { network, block: fromBlock - 1, fromBlock, head: Math.max(tip, fromBlock - 1), updatedAt: Timestamp.fromMillis(now) };
    tx.create(ref, doc);
    return doc;
  });
}

/**
 * Stores the width the next run should read its first window with, without moving the cursor: what a run does when a
 * window turned out too large for it. With it goes a ceiling, the same width, that holds until the cursor has passed
 * `ceilingUntil` (the end of the window that was too large), so the width doesn't grow straight back into it; and the
 * attempt marker goes, since this attempt ended in a way the step saw. Nothing when there is no cursor doc.
 */
export async function storePositionsSpan(db: Firestore, network: NetworkId, span: number, ceilingUntil: number): Promise<void> {
  const ref = positionsIndexRef(db, network);
  const width = Math.max(1, Math.floor(span));
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const stored = snap.data() as PositionsIndexDoc;
    // A ceiling already in force further on stays in force that far.
    tx.update(ref, { span: width, ceiling: width, ceilingUntil: Math.max(ceilingUntil, stored.ceilingUntil ?? 0), attempt: FieldValue.delete() });
  });
}

/**
 * Writes the attempt marker: the window about to be read. One small write, before the window's logs are asked for, so
 * that a run killed anywhere after it (the function's time or memory) leaves word of which window it died on.
 */
export async function markPositionsAttempt(db: Firestore, network: NetworkId, attempt: { from: number; width: number; at: number }): Promise<void> {
  await positionsIndexRef(db, network).update({ attempt });
}

/** Removes the attempt marker: the attempt ended in a way the step saw, and wasn't about the window's size. */
export async function clearPositionsAttempt(db: Firestore, network: NetworkId): Promise<void> {
  await positionsIndexRef(db, network).update({ attempt: FieldValue.delete() });
}

/**
 * What applying a window did:
 * - `applied`: its positions and pools are stored (`written` positions and `pools` pool docs were new) and the cursor is at its end;
 * - `unfinished`: the time given ran out before all its docs were stored (a round of writes wasn't started). `written` and `pools` are what this call
 *   added; the cursor has not moved, and applying the window again goes on from there;
 * - `already`: the cursor was at or past the window's end;
 * - `moved`: the cursor is not where this window starts (another run moved it), and `block` is where it is;
 * - `missing`: there is no cursor doc.
 */
export type PositionsApplyResult =
  | { kind: "applied"; block: number; written: number; pools: number }
  | { kind: "unfinished"; written: number; pools: number }
  | { kind: "already"; block: number }
  | { kind: "moved"; block: number }
  | { kind: "missing" };

/** Firestore's ALREADY_EXISTS (gRPC code 6), which a create of an existing doc fails with. */
const alreadyExists = (e: unknown): boolean => typeof e === "object" && e !== null && (e as { code?: unknown }).code === 6;

/** Firestore takes at most 500 writes in a batch; reads are chunked the same way. */
const CHUNK = 400;
/** How many chunks are read and written at once. A window of 20,000 logs is 50 chunks or more. */
const CHUNKS_AT_ONCE = 6;
/** How often a chunk of pool docs is read again after a create was refused, before the refusal is passed on. */
const CREATE_RETRIES = 3;

/**
 * Stores one window [from, to] of positions and pools, then moves the cursor to its end:
 * 1. reads which of the window's positions the index already has, and writes only the new ones, each under its own key
 *    (`positionId`). A position already stored is left as it is, so its `firstBlock` stays the first, and running a
 *    window again writes nothing;
 * 1b. the same for the window's v4 pools in pools/, but written with `create`: a pool doc is created only where there is
 *    none, and one that exists (the main indexer's, with its sampled depth) can't be written over. A batch one of whose
 *    creates is refused (ALREADY_EXISTS: the doc appeared after this step looked) writes nothing; its chunk is read
 *    again and what is still missing is written. Pool docs only: no token doc, no inspection queue, no Radar feed.
 *    The caller never reads past the main indexer's cursor (positions-run.ts), so every pool here that
 *    the main indexer is to record, it has recorded already: this step only adds the pools from before its first block,
 *    and can't take a pool's doc (the main indexer's mark that the pool's token is handled) from under it;
 * 2. in one transaction, moves the cursor from `from - 1` to `to` (forward only), or reports that it wasn't there
 *    `options.span`, the width the caller read this window with, is stored with it for the next run.
 * The positions go first: a run that dies between the two repeats the window, and never leaves the cursor past a
 * position that isn't stored. A reader that takes the cursor first and the positions after it therefore sees every
 * position opened up to that cursor.
 *
 * How long it takes: the docs go in chunks of 400, six chunks at a time, each one read and one batch. The backfill's
 * densest window (mainnet blocks 21,185,000 to 21,194,472: 19,996 logs, 7,678 of them new pools) is about 50 chunks,
 * nine rounds. `options.until` (ms on `options.clock`) bounds it all the same: no round starts at or after it, and the
 * call then answers `unfinished` with the cursor where it was. What it wrote stays. The caller reads a narrower
 * window next time (positions-run.ts halves the width), since re-reading a window's stored chunks takes time too: a
 * run with little time left would otherwise read the same chunks every time and never reach the rest.
 */
export async function applyPositionsWindow(
  db: Firestore,
  network: NetworkId,
  window: { from: number; to: number },
  positions: readonly SeenPosition[],
  options: { tip: number; now: number; pools?: readonly PoolDoc[]; until?: number; clock?: () => number; span?: number },
): Promise<PositionsApplyResult> {
  const collection = db.collection(COLLECTIONS.positions);
  const entries: { ref: DocumentReference; doc: PositionDoc }[] = positions.map((p) => ({
    ref: collection.doc(positionId(network, p.poolId, p.key)),
    doc: positionDoc(network, p.poolId, p.key, p.block),
  }));
  const poolEntries: { ref: DocumentReference; doc: PoolDoc }[] = (options.pools ?? []).map((doc) => ({
    ref: db.collection(COLLECTIONS.pools).doc(poolId(network, doc.poolId)),
    doc,
  }));
  const clock = options.clock ?? Date.now;
  const outOfTime = () => options.until !== undefined && clock() >= options.until;
  /** Writes the chunk's entries that have no doc yet, and says how many that was. */
  const addChunk = async (chunk: readonly { ref: DocumentReference; doc: PositionDoc | PoolDoc }[], create: boolean, tries = 0): Promise<number> => {
    const stored = await db.getAll(...chunk.map((e) => e.ref));
    const fresh = chunk.filter((_, n) => !stored[n]!.exists);
    if (fresh.length === 0) return 0;
    const batch = db.batch();
    for (const e of fresh) {
      if (create) batch.create(e.ref, e.doc);
      else batch.set(e.ref, e.doc);
    }
    try {
      await batch.commit();
    } catch (e) {
      // Another writer created one of these docs between the read and the write: nothing of the batch was written.
      if (!create || !alreadyExists(e) || tries >= CREATE_RETRIES) throw e;
      return addChunk(chunk, create, tries + 1);
    }
    return fresh.length;
  };
  /** Every chunk of `all`, a few at a time, until done or out of time. `done` is false when it stopped short. */
  const addAll = async (all: readonly { ref: DocumentReference; doc: PositionDoc | PoolDoc }[], create: boolean): Promise<{ added: number; done: boolean }> => {
    let added = 0;
    for (let i = 0; i < all.length; i += CHUNK * CHUNKS_AT_ONCE) {
      if (outOfTime()) return { added, done: false };
      const round = Array.from({ length: CHUNKS_AT_ONCE }, (_, n) => all.slice(i + n * CHUNK, i + (n + 1) * CHUNK)).filter((chunk) => chunk.length > 0);
      for (const count of await Promise.all(round.map((chunk) => addChunk(chunk, create)))) added += count;
    }
    return { added, done: true };
  };
  // Position docs are this step's alone, so a plain write is enough; pool docs are shared with the main indexer.
  const positionsAdded = await addAll(entries, false);
  const poolsAdded = positionsAdded.done ? await addAll(poolEntries, true) : { added: 0, done: false };
  const [written, pools] = [positionsAdded.added, poolsAdded.added];
  // Everything is stored: the cursor moves even when the time has just run out. The transaction is one read and one
  // write, and stopping here would have the next run do all of it again for nothing.
  if (!poolsAdded.done) return { kind: "unfinished", written, pools };
  const ref = positionsIndexRef(db, network);
  return db.runTransaction(async (tx): Promise<PositionsApplyResult> => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { kind: "missing" };
    const doc = snap.data() as PositionsIndexDoc;
    if (doc.block >= window.to) return { kind: "already", block: doc.block };
    if (doc.block !== window.from - 1) return { kind: "moved", block: doc.block };
    // The attempt marker goes with the move: this window is done.
    tx.update(ref, { block: window.to, head: Math.max(doc.head ?? 0, options.tip), updatedAt: Timestamp.fromMillis(options.now), attempt: FieldValue.delete(), ...(options.span === undefined ? {} : { span: options.span }) });
    return { kind: "applied", block: window.to, written, pools };
  });
}
