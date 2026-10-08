import { randomUUID } from "node:crypto";
import { Timestamp, type DocumentReference, type Firestore, type WriteBatch } from "firebase-admin/firestore";
import type { NetworkId } from "@arcos/chain";
import {
  COLLECTIONS,
  RADAR_FEED_FILTERS,
  RADAR_FEED_SIZE,
  TTL_MS,
  poolId,
  poolToDoc,
  radarFeedId,
  tokenId,
  tokenToDoc,
  type IndexerDoc,
  type RadarFeedDoc,
  type RadarFeedFilter,
  type RadarRow,
  type ReportDoc,
  type ReportSummary,
  type TokenDoc,
  type TokenRecord,
} from "@arcos/data";
import type { Report } from "@arcos/inspector";
import type { Sighting } from "./events";
import { inFeed, updateFeed } from "./feed";
import { selectPool } from "./pools";
import { newInspect, requeue } from "./queue";

// Every Firestore read and write the indexer makes. Each write is an idempotent upsert keyed by a deterministic doc id,
// so a run that repeats a window writes nothing new.

/** Firestore takes at most 500 writes in a batch; this leaves room. */
const BATCH = 400;

export const indexerRef = (db: Firestore, network: NetworkId): DocumentReference =>
  db.collection(COLLECTIONS.indexer).doc(network);

/** The UTC day an explorer call counts against, YYYY-MM-DD. */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** How long a run holds the indexer: the function's 120 s timeout, and a margin. A lease left by a run that died expires. */
export const LEASE_MS = 150_000;

/** What a run finds when it starts: its lease and the state, the state alone when paused or halted, or another run busy. */
export type Start =
  | { kind: "run"; state: IndexerDoc; runId: string }
  | { kind: "stop"; state: IndexerDoc }
  | { kind: "busy"; until: number };

const leaseOf = (doc: IndexerDoc): { runningUntil: number; runId: string | null } => ({
  runningUntil: doc.runningUntil?.toMillis() ?? 0,
  runId: doc.runId ?? null,
});

/**
 * Reads the indexer doc and takes the run's lease (`runningUntil`, `runId`) in one transaction. Another run's lease that
 * is still live makes this run skip (`busy`); a paused or halted indexer is read and nothing is written. The first run
 * creates the doc with the cursor `cursor` (the 24-hour backfill) and the console controls at their defaults: running,
 * inspecting, not halted, Watchdog and its Telegram sends on, with no Watchdog cursor yet. Two first runs can't both
 * create it: the transaction makes the second read the first's.
 */
export async function loadOrCreateState(
  db: Firestore,
  network: NetworkId,
  cursor: () => Promise<number>,
  now: number,
  runId: string = randomUUID(),
): Promise<Start> {
  const ref = indexerRef(db, network);
  // The first cursor needs the chain's head, which is no call to make inside a transaction that may run again.
  const first = (await ref.get()).exists ? null : await cursor();
  const lease = { runningUntil: Timestamp.fromMillis(now + LEASE_MS), runId };
  return db.runTransaction(async (tx): Promise<Start> => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      const doc: IndexerDoc = {
        network,
        block: first ?? (await cursor()),
        updatedAt: Timestamp.fromMillis(now),
        lastRunAt: null,
        paused: false,
        inspect: true,
        halted: null,
        explorerCalls: { day: utcDay(now), count: 0 },
        watch: true,
        telegram: true,
        watchCursor: null,
        ...lease,
      };
      tx.create(ref, doc);
      return { kind: "run", state: doc, runId };
    }
    const state = snap.data() as IndexerDoc;
    if (state.paused || state.halted) return { kind: "stop", state };
    const held = leaseOf(state);
    if (held.runningUntil > now && held.runId !== runId) return { kind: "busy", until: held.runningUntil };
    tx.update(ref, lease);
    return { kind: "run", state: { ...state, ...lease }, runId };
  });
}

/** Gives the lease back, if it is still this run's (a run that outlived its lease leaves the next one's alone). */
export async function releaseLease(db: Firestore, network: NetworkId, runId: string): Promise<void> {
  const ref = indexerRef(db, network);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists && leaseOf(snap.data() as IndexerDoc).runId === runId) tx.update(ref, { runningUntil: null, runId: null });
  });
}

/** Commits `writes` in order, in batches of at most `size`. */
async function commitAll(db: Firestore, writes: ((batch: WriteBatch) => void)[], size = BATCH): Promise<void> {
  for (let i = 0; i < writes.length; i += size) {
    const batch = db.batch();
    for (const write of writes.slice(i, i + size)) write(batch);
    await batch.commit();
  }
}

/** What one window added to the index. `changed` are the token docs as written, for the Radar feeds. */
export type WindowResult = { pools: number; tokens: number; requeued: number; changed: TokenDoc[] };

type Found = { record: TokenRecord; pooled: boolean };

/**
 * Records one window's sightings: every new qualifying pool, every new token, and a token already known queued again when
 * a new pool appeared for it. Reads first which of them exist (one read each), then writes only what is new. The caller
 * writes the cursor after this returns, so a crash repeats the window and never skips it.
 *
 * A pool doc is the mark that its sighting is fully handled: a pool that exists is never handled again. So the token
 * writes (the new tokens and the requeues) are committed first and the pools after them, in that order across batches;
 * a crash between the two leaves the pools missing, and the window read again requeues their tokens.
 * New docs are created, never set: a token another run created (and maybe inspected) since the reads is not
 * overwritten. Such a create fails, and the window is read and written once more, leaving that doc alone.
 * `batchSize` is for the tests.
 */
export async function recordWindow(
  db: Firestore,
  network: NetworkId,
  sightings: readonly Sighting[],
  options: { inspect: boolean; now: number; batchSize?: number },
): Promise<WindowResult> {
  try {
    return await writeWindow(db, network, sightings, options);
  } catch (e) {
    // Another run created one of these docs between the reads and the writes: read again, and write what is still new.
    if (!alreadyExists(e)) throw e;
    return writeWindow(db, network, sightings, options);
  }
}

/** Firestore's ALREADY_EXISTS (gRPC code 6), which a create of an existing doc fails with. */
const alreadyExists = (e: unknown): boolean => typeof e === "object" && e !== null && (e as { code?: unknown }).code === 6;

async function writeWindow(
  db: Firestore,
  network: NetworkId,
  sightings: readonly Sighting[],
  options: { inspect: boolean; now: number; batchSize?: number },
): Promise<WindowResult> {
  const now = Timestamp.fromMillis(options.now);
  const pools = new Map<string, ReturnType<typeof poolToDoc>>();
  const found = new Map<string, Found>();
  const seen = (s: Sighting) => (s.timestamp === null ? now : Timestamp.fromMillis(s.timestamp * 1000));
  const base = (address: `0x${string}`, s: Sighting): TokenRecord => ({
    network,
    address,
    name: null,
    symbol: null,
    decimals: null,
    totalSupply: null,
    source: "factory",
    creator: null,
    firstBlock: s.block,
    firstSeen: seen(s),
    bestPool: null,
    report: null,
    radar: { liquid: false, passing: false },
    inspect: newInspect(options.inspect, false, now),
    launchpad: null,
  });

  for (const s of sightings) {
    if (s.kind === "token") {
      if (!found.has(s.token)) {
        found.set(s.token, {
          record: { ...base(s.token, s), name: s.name, symbol: s.symbol, decimals: s.decimals, totalSupply: s.initialSupply, creator: s.creator },
          pooled: false,
        });
      }
      continue;
    }
    const selected = selectPool(s, network);
    if (!selected) continue;
    const id = poolId(network, selected.pool.poolId);
    if (!pools.has(id)) pools.set(id, poolToDoc(selected.pool));
    const entry = found.get(selected.token) ?? { record: { ...base(selected.token, s), source: s.version }, pooled: false };
    entry.pooled = true;
    found.set(selected.token, entry);
  }
  if (pools.size === 0 && found.size === 0) return { pools: 0, tokens: 0, requeued: 0, changed: [] };

  const poolIds = [...pools.keys()];
  const poolSnaps = poolIds.length ? await db.getAll(...poolIds.map((id) => db.collection(COLLECTIONS.pools).doc(id))) : [];
  const newPools = new Set(poolIds.filter((_, i) => !poolSnaps[i]!.exists));
  const tokensWithNewPool = new Set([...newPools].map((id) => pools.get(id)!.token));

  const tokenIds = [...found.keys()].map((address) => tokenId(network, address));
  const tokenSnaps = await db.getAll(...tokenIds.map((id) => db.collection(COLLECTIONS.tokens).doc(id)));

  const writes: ((batch: WriteBatch) => void)[] = [];
  const changed: TokenDoc[] = [];
  let created = 0;
  let requeued = 0;
  [...found.values()].forEach(({ record, pooled }, i) => {
    const ref = db.collection(COLLECTIONS.tokens).doc(tokenIds[i]!);
    const snap = tokenSnaps[i]!;
    if (!snap.exists) {
      const doc = tokenToDoc({ ...record, inspect: newInspect(options.inspect, pooled, now) });
      writes.push((batch) => batch.create(ref, doc));
      changed.push(doc);
      created++;
      return;
    }
    if (!tokensWithNewPool.has(record.address)) return;
    const next = requeue(snap.data() as TokenDoc, options.inspect, now);
    if (next === null) return;
    writes.push((batch) => batch.update(ref, { inspect: next }));
    requeued++;
  });
  // Last: the pools, the marks that the tokens above are written.
  for (const id of newPools) {
    const doc = pools.get(id)!;
    writes.push((batch) => batch.create(db.collection(COLLECTIONS.pools).doc(id), doc));
  }
  await commitAll(db, writes, options.batchSize);
  return { pools: newPools.size, tokens: created, requeued, changed };
}

/**
 * Moves the cursor: the window up to `block` is fully handled. Only forward: a run that is behind another (one that
 * outlived its lease) never moves the cursor back. Returns whether it moved.
 */
export async function writeCursor(db: Firestore, network: NetworkId, block: number, now: number): Promise<boolean> {
  const ref = indexerRef(db, network);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || (snap.data() as IndexerDoc).block >= block) return false;
    tx.update(ref, { block, updatedAt: Timestamp.fromMillis(now) });
    return true;
  });
}

/** The indexer stops itself until someone clears `halted` in the console. */
export async function halt(db: Firestore, network: NetworkId, reason: string): Promise<void> {
  await indexerRef(db, network).update({ halted: reason });
}

/**
 * The end of a run, in one transaction: `lastRunAt` (never moved back), the explorer calls this run spent added to what
 * the doc holds for that UTC day, the Watchdog step's page cursor when the step ran (`watchCursor`; undefined leaves
 * the stored one), and the lease given back if it is still this run's. Adding, rather than writing the count the run
 * started from plus its own, keeps the calls of a run that overlapped this one (one that outlived its lease) in the
 * day's count.
 */
export async function finishRun(
  db: Firestore,
  network: NetworkId,
  now: number,
  spent: { day: string; calls: number },
  runId: string,
  watchCursor?: string | null,
): Promise<void> {
  const ref = indexerRef(db, network);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const doc = snap.data() as IndexerDoc;
    const mine = leaseOf(doc).runId === runId;
    const stored = doc.explorerCalls;
    // A later day already counted by another run: this run's calls belong to a day that is over.
    const explorerCalls =
      stored.day === spent.day ? { day: spent.day, count: stored.count + spent.calls } : stored.day > spent.day ? stored : { day: spent.day, count: spent.calls };
    const lastRunAt = Math.max(doc.lastRunAt?.toMillis() ?? 0, now);
    tx.update(ref, {
      lastRunAt: Timestamp.fromMillis(lastRunAt),
      explorerCalls,
      ...(watchCursor === undefined ? {} : { watchCursor }),
      ...(mine ? { runningUntil: null, runId: null } : {}),
    });
  });
}

/** The head of the inspection queue, in queue order (the composite index on network, inspect.state, inspect.priority, firstSeen). */
export async function queueHead(db: Firestore, network: NetworkId, limit: number): Promise<TokenDoc[]> {
  const snap = await db
    .collection(COLLECTIONS.tokens)
    .where("network", "==", network)
    .where("inspect.state", "==", "queued")
    .orderBy("inspect.priority", "desc")
    .orderBy("firstSeen", "desc")
    .limit(limit)
    .get();
  return snap.docs.map((doc) => doc.data() as TokenDoc);
}

/** Writes a token's queue entry alone (an expiry, a failed attempt). */
export async function setInspect(db: Firestore, token: TokenDoc, inspect: TokenDoc["inspect"]): Promise<void> {
  await db.collection(COLLECTIONS.tokens).doc(tokenId(token.network, token.address)).update({ inspect });
}

/**
 * Stores an inspection: the full report (90 days, TTL on expiresAt) and, on the token, what Radar reads. Returns the
 * token doc as written. `degraded` is the report's own, or true when the explorer budget left the inspection RPC-only.
 */
export async function saveInspection(
  db: Firestore,
  token: TokenDoc,
  done: {
    report: Report;
    summary: ReportSummary;
    radar: TokenDoc["radar"];
    bestPool: TokenDoc["bestPool"] | undefined;
    degraded: boolean;
    now: number;
  },
): Promise<TokenDoc> {
  const id = tokenId(token.network, token.address);
  const now = Timestamp.fromMillis(done.now);
  const { report } = done;
  // The report is JSON-safe by design (no bigint); this also drops any undefined, which Firestore refuses.
  const stored = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
  const reportDoc: ReportDoc = {
    network: token.network,
    address: token.address,
    block: done.summary.block,
    passed: report.passed,
    total: report.total,
    explorerReachable: report.explorerReachable,
    degraded: done.degraded,
    report: stored,
    createdAt: now,
    expiresAt: Timestamp.fromMillis(done.now + TTL_MS.reports),
  };
  const next: TokenDoc = {
    ...token,
    name: report.token.name ?? token.name,
    symbol: report.token.symbol ?? token.symbol,
    decimals: report.token.decimals ?? token.decimals,
    totalSupply: report.token.totalSupply ?? token.totalSupply,
    report: done.summary,
    radar: done.radar,
    bestPool: done.bestPool === undefined ? token.bestPool : done.bestPool,
    inspect: { state: "done", priority: token.inspect.priority, attempts: token.inspect.attempts, queuedAt: null },
  };
  const batch = db.batch();
  batch.set(db.collection(COLLECTIONS.reports).doc(id), reportDoc);
  batch.update(db.collection(COLLECTIONS.tokens).doc(id), {
    name: next.name,
    symbol: next.symbol,
    decimals: next.decimals,
    totalSupply: next.totalSupply,
    report: next.report,
    radar: next.radar,
    bestPool: next.bestPool,
    inspect: next.inspect,
  });
  await batch.commit();
  return next;
}

/** The newest tokens on a feed, from the composite indexes on network, the radar flags and firstSeen. */
async function feedQuery(db: Firestore, network: NetworkId, filter: RadarFeedFilter): Promise<TokenDoc[]> {
  let query = db.collection(COLLECTIONS.tokens).where("network", "==", network);
  if (filter === "liquid" || filter === "liquid-passing") query = query.where("radar.liquid", "==", true);
  if (filter === "passing" || filter === "liquid-passing") query = query.where("radar.passing", "==", true);
  const snap = await query.orderBy("firstSeen", "desc").limit(RADAR_FEED_SIZE).get();
  return snap.docs.map((doc) => doc.data() as TokenDoc).filter((token) => inFeed(filter, token));
}

/** Whether two pages hold the same rows, field by field. */
function sameRows(a: readonly RadarRow[], b: readonly RadarRow[]): boolean {
  const key = (r: RadarRow) => [
    r.address, r.symbol, r.name, r.source, r.firstSeen.toMillis(), r.passed, r.total, r.bestPoolDepth, r.decimals ?? null, r.creator ?? null,
  ];
  return a.length === b.length && a.every((row, i) => JSON.stringify(key(row)) === JSON.stringify(key(b[i]!)));
}

/** The feed a run rebuilds from its query whatever changed: one of the four in turn, a new one each minute. */
export const rebuiltFeed = (now: number): RadarFeedFilter => RADAR_FEED_FILTERS[Math.floor(now / 60_000) % RADAR_FEED_FILTERS.length]!;

/**
 * Brings the four radarFeed docs up to date with the tokens this run changed, and rebuilds one of them from its query
 * (`rebuild`, rebuiltFeed in turn), so a page that missed a change (a run that died between an inspection and this
 * write) is whole again within four runs. Four reads, plus one query of up to 50 reads for the rebuilt feed, a feed
 * that has no doc yet, or one that lost a row from a full page; a write for each page that changed. Returns how many
 * pages it wrote.
 */
export async function updateFeeds(
  db: Firestore,
  network: NetworkId,
  changed: readonly TokenDoc[],
  now: number,
  rebuild: RadarFeedFilter | null = rebuiltFeed(now),
): Promise<number> {
  if (changed.length === 0 && rebuild === null) return 0;
  const refs = RADAR_FEED_FILTERS.map((filter) => db.collection(COLLECTIONS.radarFeed).doc(radarFeedId(network, filter)));
  const snaps = await db.getAll(...refs);
  const batch = db.batch();
  let written = 0;
  for (const [i, filter] of RADAR_FEED_FILTERS.entries()) {
    const current = snaps[i]!.exists ? (snaps[i]!.data() as RadarFeedDoc).rows : null;
    if (filter !== rebuild && changed.length === 0 && current !== null) continue;
    let rows = current === null || filter === rebuild ? null : updateFeed(current, changed, filter);
    if (rows === null || rows.refill) rows = updateFeed([], await feedQuery(db, network, filter), filter);
    if (current !== null && sameRows(current, rows.rows)) continue;
    const doc: RadarFeedDoc = { network, filter, rows: rows.rows, updatedAt: Timestamp.fromMillis(now) };
    batch.set(refs[i]!, doc);
    written++;
  }
  if (written > 0) await batch.commit();
  return written;
}
