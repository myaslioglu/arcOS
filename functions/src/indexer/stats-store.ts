import { FieldValue, Timestamp, type Firestore, type Query } from "firebase-admin/firestore";
import type { NetworkId } from "@arcos/chain";
import { COLLECTIONS, statsDaysId, statsId, type StatsDaysDoc, type StatsDoc } from "@arcos/data";
import type { RawLog } from "./events";
import { STATS_EXCLUDED_WALLETS, decodeStatsLogs, docFieldsOf, emptyStatsState, foldStats, stateOfDoc, type StatsDelta, type StatsSource } from "./stats";

// Every Firestore read and write of the usage counter (Stats). The totals and the cursor live in one doc, stats/{network},
// and a window is applied to it in one transaction: that is what makes each log count once.

export const statsRef = (db: Firestore, network: NetworkId) => db.collection(COLLECTIONS.stats).doc(statsId(network));

/** How often the server counts (users, watches, tokens) are taken again. */
export const SERVER_COUNT_EVERY_MS = 10 * 60_000;

/**
 * The stats doc, created on the first run: no totals, the cursor one block before `from.block` (so that block's logs are
 * counted), `head` at the run's `tip` (so a fresh doc reads as far behind), and counting dated `from.at`. An existing doc's `head` is raised to `tip`. Two first runs can't both create it: the transaction makes the second read the first's.
 */
export async function ensureStats(
  db: Firestore,
  network: NetworkId,
  from: { block: number; at: string },
  now: number,
  tip: number,
): Promise<StatsDoc> {
  const ref = statsRef(db, network);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      // The head moves on every run, whether or not a window is applied, so `head - block` is how far behind counting is.
      const stored = snap.data() as StatsDoc;
      if ((stored.head ?? 0) >= tip) return stored;
      tx.update(ref, { head: tip });
      return { ...stored, head: tip };
    }
    const doc: StatsDoc = {
      network,
      block: from.block - 1,
      fromBlock: from.block,
      head: Math.max(tip, from.block - 1),
      ...docFieldsOf(emptyStatsState()),
      server: null,
      onchainSince: Timestamp.fromMillis(Date.parse(`${from.at}T00:00:00Z`)),
      updatedAt: Timestamp.fromMillis(now),
    };
    tx.create(ref, doc);
    return doc;
  });
}

/**
 * What applying a window did:
 * - `applied`: the window's logs are in the totals and the cursor is at its end;
 * - `already`: the cursor was at or past the window's end, so nothing was written (the window was applied before);
 * - `moved`: the cursor is not where this window starts (another run moved it): nothing was written, and `block` is where it is;
 * - `missing`: there is no stats doc.
 */
export type ApplyResult =
  | { kind: "applied"; block: number; delta: StatsDelta }
  | { kind: "already"; block: number }
  | { kind: "moved"; block: number }
  | { kind: "missing" };

/**
 * Applies one window [from, to] to the totals, in one transaction: reads the doc; stops if its cursor is already at or past
 * `to` (applied before); stops if the cursor isn't `from - 1` (another run moved it; the caller reads again); otherwise
 * folds the window's logs, and writes the totals, the fee values, the cursor (`block = to`, forward only) and each touched
 * day's increments together. A transaction that Firestore runs again folds again from the doc it read: the fold has no
 * state of its own. `tip` is the head this window was read against, kept as `head`.
 */
export async function applyStatsWindow(
  db: Firestore,
  network: NetworkId,
  window: { from: number; to: number },
  logs: readonly RawLog[],
  options: { sources: readonly StatsSource[]; tip: number; now: number; excluded?: readonly string[] },
): Promise<ApplyResult> {
  const ref = statsRef(db, network);
  const events = decodeStatsLogs(logs, options.sources, window);
  return db.runTransaction(async (tx): Promise<ApplyResult> => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { kind: "missing" };
    const doc = snap.data() as StatsDoc;
    if (doc.block >= window.to) return { kind: "already", block: doc.block };
    if (doc.block !== window.from - 1) return { kind: "moved", block: doc.block };
    const { state, delta, days } = foldStats(stateOfDoc(doc), events, options.excluded ?? STATS_EXCLUDED_WALLETS);
    tx.update(ref, { ...docFieldsOf(state), block: window.to, head: Math.max(doc.head ?? 0, options.tip), updatedAt: Timestamp.fromMillis(options.now) });
    const months = new Map<string, StatsDaysDoc["days"]>();
    for (const [day, c] of days) {
      const month = day.slice(0, 7);
      const entry = months.get(month) ?? {};
      entry[day] = {
        tokensCreated: FieldValue.increment(c.tokensCreated) as unknown as number,
        drops: FieldValue.increment(c.drops) as unknown as number,
        rowsDelivered: FieldValue.increment(c.rowsDelivered) as unknown as number,
      };
      months.set(month, entry);
    }
    for (const [month, entry] of months) {
      tx.set(db.collection(COLLECTIONS.statsDays).doc(statsDaysId(network, month)), { network, month, days: entry }, { merge: true });
    }
    return { kind: "applied", block: window.to, delta };
  });
}

const total = async (query: Query): Promise<number> => (await query.count().get()).data().count;
/** The oldest of the first `SINCE_SCAN` docs by `field` that `keep` accepts: a single-field order, so no composite index. */
const SINCE_SCAN = 25;
const oldest = async (query: Query, field: string, keep: (doc: { get(field: string): unknown }) => boolean = () => true): Promise<Timestamp | null> => {
  const snap = await query.orderBy(field).limit(SINCE_SCAN).get();
  const doc = snap.docs.find((d) => keep(d));
  const value: unknown = doc?.get(field);
  return value instanceof Timestamp ? value : null;
};

/**
 * The counts of ArcOS's own data, written into `stats/{network}.server` with the time they were taken: six `count()`
 * aggregations and three one-doc reads for the "since" dates. Equality or single-field filters only, so no composite index.
 * - users: wallets that signed in; telegramLinked: those with a linked chat;
 * - watches and watchedTokens (one watchState doc per watched token), of this network;
 * - tokensIndexed (tokens of this network) and tokensInspected (those whose inspection is done).
 * Counts only: no address is read into the answer.
 */
export async function writeServerCounts(db: Firestore, network: NetworkId, now: number): Promise<void> {
  const c = (name: string) => db.collection(name);
  const ofNetwork = (d: { get(field: string): unknown }) => d.get("network") === network;
  const [users, telegramLinked, watches, watchedTokens, tokensIndexed, tokensInspected, usersSince, telegramSince, watchesSince, tokensSince] = await Promise.all([
    total(c(COLLECTIONS.users)),
    total(c(COLLECTIONS.users).where("telegram.linkedAt", "!=", null)),
    total(c(COLLECTIONS.watches).where("network", "==", network)),
    total(c(COLLECTIONS.watchState).where("network", "==", network)),
    total(c(COLLECTIONS.tokens).where("network", "==", network)),
    total(c(COLLECTIONS.tokens).where("network", "==", network).where("inspect.state", "==", "done")),
    oldest(c(COLLECTIONS.users), "createdAt"),
    oldest(c(COLLECTIONS.users).where("telegram.linkedAt", "!=", null), "telegram.linkedAt"),
    oldest(c(COLLECTIONS.watches), "createdAt", ofNetwork),
    oldest(c(COLLECTIONS.tokens), "firstSeen", ofNetwork),
  ]);
  await statsRef(db, network).update({
    server: {
      users,
      telegramLinked,
      watches,
      watchedTokens,
      tokensIndexed,
      tokensInspected,
      since: { users: usersSince, telegram: telegramSince, watches: watchesSince, tokens: tokensSince },
      countedAt: Timestamp.fromMillis(now),
    } satisfies NonNullable<StatsDoc["server"]>,
  });
}
