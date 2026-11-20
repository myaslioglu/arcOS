import { Timestamp, type DocumentReference, type Firestore } from "firebase-admin/firestore";
import type { NetworkId } from "@arcos/chain";
import { COLLECTIONS, positionDoc, positionId, positionsIndexId, type PositionDoc, type PositionsIndexDoc } from "@arcos/data";
import { positionFromLog, type V4PositionKey } from "@arcos/inspector";
import type { RawLog } from "./events";

// Every Firestore read and write of the position index. A position is one doc under the PoolManager's own key for it
// (positions/), written once; the cursor is one doc (positionsIndex/{network}), moved after a window's positions are in.

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
 * What applying a window did:
 * - `applied`: its positions are stored (`written` of them were new) and the cursor is at its end;
 * - `already`: the cursor was at or past the window's end;
 * - `moved`: the cursor is not where this window starts (another run moved it), and `block` is where it is;
 * - `missing`: there is no cursor doc.
 */
export type PositionsApplyResult =
  | { kind: "applied"; block: number; written: number }
  | { kind: "already"; block: number }
  | { kind: "moved"; block: number }
  | { kind: "missing" };

/** Firestore takes at most 500 writes in a batch; reads are chunked the same way. */
const CHUNK = 400;

/**
 * Stores one window [from, to] of positions, then moves the cursor to its end:
 * 1. reads which of the window's positions the index already has, and writes only the new ones, each under its own key
 *    (`positionId`). A position already stored is left as it is, so its `firstBlock` stays the first, and running a
 *    window again writes nothing;
 * 2. in one transaction, moves the cursor from `from - 1` to `to` (forward only), or reports that it wasn't there.
 * The positions go first: a run that dies between the two repeats the window, and never leaves the cursor past a
 * position that isn't stored. A reader that takes the cursor first and the positions after it therefore sees every
 * position opened up to that cursor.
 */
export async function applyPositionsWindow(
  db: Firestore,
  network: NetworkId,
  window: { from: number; to: number },
  positions: readonly SeenPosition[],
  options: { tip: number; now: number },
): Promise<PositionsApplyResult> {
  const collection = db.collection(COLLECTIONS.positions);
  const entries: { ref: DocumentReference; doc: PositionDoc }[] = positions.map((p) => ({
    ref: collection.doc(positionId(network, p.poolId, p.key)),
    doc: positionDoc(network, p.poolId, p.key, p.block),
  }));
  let written = 0;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    const stored = await db.getAll(...chunk.map((e) => e.ref));
    const fresh = chunk.filter((_, n) => !stored[n]!.exists);
    if (fresh.length === 0) continue;
    const batch = db.batch();
    for (const e of fresh) batch.set(e.ref, e.doc);
    await batch.commit();
    written += fresh.length;
  }
  const ref = positionsIndexRef(db, network);
  return db.runTransaction(async (tx): Promise<PositionsApplyResult> => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { kind: "missing" };
    const doc = snap.data() as PositionsIndexDoc;
    if (doc.block >= window.to) return { kind: "already", block: doc.block };
    if (doc.block !== window.from - 1) return { kind: "moved", block: doc.block };
    tx.update(ref, { block: window.to, head: Math.max(doc.head ?? 0, options.tip), updatedAt: Timestamp.fromMillis(options.now) });
    return { kind: "applied", block: window.to, written };
  });
}
