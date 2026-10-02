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

/**
 * The indexer doc, created on the first run with the cursor `cursor` (the 24-hour backfill) and the console controls at
 * their defaults: running, inspecting, not halted. Two first runs can't both create it: the second reads the first's.
 */
export async function loadOrCreateState(db: Firestore, network: NetworkId, cursor: () => Promise<number>, now: number): Promise<IndexerDoc> {
  const ref = indexerRef(db, network);
  const snap = await ref.get();
  if (snap.exists) return snap.data() as IndexerDoc;
  const doc: IndexerDoc = {
    network,
    block: await cursor(),
    updatedAt: Timestamp.fromMillis(now),
    lastRunAt: null,
    paused: false,
    inspect: true,
    halted: null,
    explorerCalls: { day: utcDay(now), count: 0 },
  };
  try {
    await ref.create(doc);
    return doc;
  } catch {
    return (await ref.get()).data() as IndexerDoc;
  }
}

/** Commits `writes` in batches of at most BATCH. */
async function commitAll(db: Firestore, writes: ((batch: WriteBatch) => void)[]): Promise<void> {
  for (let i = 0; i < writes.length; i += BATCH) {
    const batch = db.batch();
    for (const write of writes.slice(i, i + BATCH)) write(batch);
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
 */
export async function recordWindow(
  db: Firestore,
  network: NetworkId,
  sightings: readonly Sighting[],
  options: { inspect: boolean; now: number },
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
  for (const id of newPools) {
    const doc = pools.get(id)!;
    writes.push((batch) => batch.set(db.collection(COLLECTIONS.pools).doc(id), doc));
  }
  [...found.values()].forEach(({ record, pooled }, i) => {
    const ref = db.collection(COLLECTIONS.tokens).doc(tokenIds[i]!);
    const snap = tokenSnaps[i]!;
    if (!snap.exists) {
      const doc = tokenToDoc({ ...record, inspect: newInspect(options.inspect, pooled, now) });
      writes.push((batch) => batch.set(ref, doc));
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
  await commitAll(db, writes);
  return { pools: newPools.size, tokens: created, requeued, changed };
}

/** Moves the cursor: the window up to `block` is fully handled. */
export async function writeCursor(db: Firestore, network: NetworkId, block: number, now: number): Promise<void> {
  await indexerRef(db, network).update({ block, updatedAt: Timestamp.fromMillis(now) });
}

/** The indexer stops itself until someone clears `halted` in the console. */
export async function halt(db: Firestore, network: NetworkId, reason: string): Promise<void> {
  await indexerRef(db, network).update({ halted: reason });
}

/** The end of a run: when it ran, and the explorer calls spent today. */
export async function finishRun(db: Firestore, network: NetworkId, now: number, explorerCalls: IndexerDoc["explorerCalls"]): Promise<void> {
  await indexerRef(db, network).update({ lastRunAt: Timestamp.fromMillis(now), explorerCalls });
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

/**
 * Brings the four radarFeed docs up to date with the tokens this run changed. Four reads, plus one query of up to 50
 * reads for a feed that has no doc yet or lost a row from a full page; four writes.
 */
export async function updateFeeds(db: Firestore, network: NetworkId, changed: readonly TokenDoc[], now: number): Promise<number> {
  if (changed.length === 0) return 0;
  const refs = RADAR_FEED_FILTERS.map((filter) => db.collection(COLLECTIONS.radarFeed).doc(radarFeedId(network, filter)));
  const snaps = await db.getAll(...refs);
  const batch = db.batch();
  for (const [i, filter] of RADAR_FEED_FILTERS.entries()) {
    const current = snaps[i]!.exists ? (snaps[i]!.data() as RadarFeedDoc).rows : null;
    let rows = current === null ? null : updateFeed(current, changed, filter);
    if (rows === null || rows.refill) rows = updateFeed([], await feedQuery(db, network, filter), filter);
    const doc: RadarFeedDoc = { network, filter, rows: rows.rows, updatedAt: Timestamp.fromMillis(now) };
    batch.set(refs[i]!, doc);
  }
  await batch.commit();
  return RADAR_FEED_FILTERS.length;
}
