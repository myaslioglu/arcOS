import { FieldPath, Timestamp, type DocumentReference, type Firestore, type WriteBatch } from "firebase-admin/firestore";
import type { Address, NetworkId } from "@arcos/chain";
import {
  COLLECTIONS,
  TTL_MS,
  deliveryId,
  poolId,
  tokenId,
  watchStatePatchToDoc,
  type AlertDoc,
  type AlertDraft,
  type DeliveryDoc,
  type PoolDoc,
  type TokenDoc,
  type UserDoc,
  type WatchDoc,
  type WatchStateDoc,
  type WatchStatePatch,
} from "@arcos/data";

// Every Firestore read and write of the Watchdog step (design 3.3). The watchState change and its alerts go in one
// batch; the deliveries come after, from a fan-out that can stop and resume, keyed by deterministic ids and created
// only when missing, so a run that dies anywhere leaves nothing to undo and nothing to send twice.

/** Firestore takes at most 500 writes in a batch; this leaves room. */
const BATCH = 400;

/** Commits `writes` in order, in batches of at most `size`. */
async function commitAll(db: Firestore, writes: ((batch: WriteBatch) => void)[], size = BATCH): Promise<void> {
  for (let i = 0; i < writes.length; i += size) {
    const batch = db.batch();
    for (const write of writes.slice(i, i + size)) write(batch);
    await batch.commit();
  }
}

/** Firestore's NOT_FOUND (gRPC code 5), which an update of a deleted doc fails with. */
export const isNotFound = (e: unknown): boolean => typeof e === "object" && e !== null && (e as { code?: unknown }).code === 5;

export type WatchStateRow = { id: string; ref: DocumentReference; doc: WatchStateDoc };

/**
 * The next `limit` watchState docs of `network` after `cursor` (a doc id, or null for the start), in doc id order,
 * wrapping once to the start to fill the page. The round robin: a run checks the page after the one the last run
 * ended at, and every watched token gets its turn. Each doc once, in the order read. An equality filter ordered by the
 * doc id, which Firestore serves from its single-field indexes.
 */
export async function watchPage(db: Firestore, network: NetworkId, cursor: string | null, limit: number): Promise<WatchStateRow[]> {
  if (limit <= 0) return [];
  const base = db.collection(COLLECTIONS.watchState).where("network", "==", network).orderBy(FieldPath.documentId());
  const first = await (cursor === null ? base : base.startAfter(cursor)).limit(limit).get();
  const rows = first.docs.map((doc) => ({ id: doc.id, ref: doc.ref, doc: doc.data() as WatchStateDoc }));
  if (cursor === null || rows.length >= limit) return rows;
  const seen = new Set(rows.map((row) => row.id));
  const wrapped = await base.limit(limit - rows.length).get();
  for (const doc of wrapped.docs) {
    if (seen.has(doc.id)) continue;
    seen.add(doc.id);
    rows.push({ id: doc.id, ref: doc.ref, doc: doc.data() as WatchStateDoc });
  }
  return rows;
}

/** What the index knows of a watched token: its doc, and the doc of its deepest pool. Either may be missing. */
export type TokenContext = { token: TokenDoc | null; pool: PoolDoc | null };

/**
 * The tokens docs of a page in one getAll, then the pools docs of their deepest pools in one more. A token the index
 * never recorded (watched by address before any pool appeared) has neither.
 */
export async function tokenContext(db: Firestore, network: NetworkId, tokens: readonly Address[]): Promise<Map<string, TokenContext>> {
  const context = new Map<string, TokenContext>();
  if (tokens.length === 0) return context;
  const unique = [...new Set(tokens.map((t) => t.toLowerCase() as Address))];
  const tokenSnaps = await db.getAll(...unique.map((token) => db.collection(COLLECTIONS.tokens).doc(tokenId(network, token))));
  const docs = unique.map((token, i) => ({ token, doc: tokenSnaps[i]!.exists ? (tokenSnaps[i]!.data() as TokenDoc) : null }));
  const poolIds = [...new Set(docs.flatMap(({ doc }) => (doc?.bestPool ? [poolId(network, doc.bestPool.id)] : [])))];
  const poolSnaps = poolIds.length ? await db.getAll(...poolIds.map((id) => db.collection(COLLECTIONS.pools).doc(id))) : [];
  const pools = new Map(poolIds.map((id, i) => [id, poolSnaps[i]!.exists ? (poolSnaps[i]!.data() as PoolDoc) : null]));
  for (const { token, doc } of docs) {
    context.set(token, { token: doc, pool: doc?.bestPool ? (pools.get(poolId(network, doc.bestPool.id)) ?? null) : null });
  }
  return context;
}

/**
 * One check's writes in one batch: the watchState patch (never `watchers`, which the watch transactions own) and one
 * alert doc per draft, each a Firestore auto id, `fannedOut: false`. NOT_FOUND means the last watcher left since the
 * page was read, and the doc with it: nothing to record, and the alerts go unwritten with it. Returns whether the
 * batch was written.
 */
export async function commitCheck(
  db: Firestore,
  state: WatchStateRow,
  patch: WatchStatePatch | null,
  drafts: readonly AlertDraft[],
  now: number,
): Promise<{ written: boolean; alerts: number }> {
  if (patch === null && drafts.length === 0) return { written: false, alerts: 0 };
  const batch = db.batch();
  if (patch !== null) batch.update(state.ref, watchStatePatchToDoc(patch));
  for (const draft of drafts) {
    const alert: AlertDoc = {
      network: state.doc.network,
      token: state.doc.token,
      kind: draft.kind,
      detail: draft.detail,
      block: draft.block,
      createdAt: Timestamp.fromMillis(now),
      expiresAt: Timestamp.fromMillis(now + TTL_MS.alerts),
      fannedOut: false,
    };
    batch.create(db.collection(COLLECTIONS.alerts).doc(), alert);
  }
  try {
    await batch.commit();
  } catch (e) {
    if (!isNotFound(e)) throw e;
    return { written: false, alerts: 0 };
  }
  return { written: true, alerts: drafts.length };
}

export type AlertRow = { id: string; ref: DocumentReference; doc: AlertDoc };

/** The alerts of `network` whose fan-out hasn't finished, at most `limit`. Two equality filters, from single-field indexes. */
export async function pendingFanout(db: Firestore, network: NetworkId, limit: number): Promise<AlertRow[]> {
  const snap = await db.collection(COLLECTIONS.alerts).where("network", "==", network).where("fannedOut", "==", false).limit(limit).get();
  return snap.docs.map((doc) => ({ id: doc.id, ref: doc.ref, doc: doc.data() as AlertDoc }));
}

/** How many deliveries a fan-out may still create this run, and whether it may still start a page. */
export type FanoutBudget = { remaining(): number; spend(count: number): void; late(): boolean };

/**
 * Creates the alert's deliveries, one per watcher with a Telegram chat, then marks the alert fanned out. Resumable: the
 * watches are paged in doc id order, each page's users are read in one getAll, the delivery ids are deterministic
 * (deliveryId) and read in one more getAll, and only the missing ones are created. The alert stays `fannedOut: false`
 * when the run's budget or its time is up before the last page, and the next run carries on from the first page: what
 * exists already is skipped at the cost of its reads. Returns how many deliveries were created and whether the alert
 * is done.
 */
export async function fanoutAlert(db: Firestore, alert: AlertRow, budget: FanoutBudget, now: number, pageSize = BATCH): Promise<{ created: number; done: boolean }> {
  const { network, token } = alert.doc;
  let created = 0;
  let after: string | null = null;
  for (;;) {
    if (budget.late() || budget.remaining() <= 0) return { created, done: false };
    let query = db.collection(COLLECTIONS.watches).where("network", "==", network).where("token", "==", token).orderBy(FieldPath.documentId()).limit(pageSize);
    if (after !== null) query = query.startAfter(after);
    const page = await query.get();
    if (page.empty) break;
    after = page.docs.at(-1)!.id;
    const watchers = [...new Set(page.docs.map((doc) => (doc.data() as WatchDoc).user))];
    const userSnaps = await db.getAll(...watchers.map((user) => db.collection(COLLECTIONS.users).doc(user)));
    const linked = watchers.filter((_, i) => {
      const snap = userSnaps[i]!;
      return snap.exists && (snap.data() as Partial<UserDoc>).telegram != null;
    });
    if (linked.length > 0) {
      const refs = linked.map((user) => db.collection(COLLECTIONS.deliveries).doc(deliveryId(alert.id, user)));
      const existing = await db.getAll(...refs);
      const missing = linked.filter((_, i) => !existing[i]!.exists);
      // The page is at most one batch wide, and the budget caps the run: a page that doesn't fit is left for the next run.
      if (missing.length > budget.remaining()) return { created, done: false };
      const writes = missing.map((user) => {
        const ref = refs[linked.indexOf(user)]!;
        const doc: DeliveryDoc = {
          alertId: alert.id,
          user,
          channel: "telegram",
          status: "pending",
          attempts: 0,
          error: null,
          createdAt: Timestamp.fromMillis(now),
          deliveredAt: null,
          expiresAt: Timestamp.fromMillis(now + TTL_MS.deliveries),
        };
        return (batch: WriteBatch) => batch.create(ref, doc);
      });
      await commitAll(db, writes, pageSize);
      budget.spend(missing.length);
      created += missing.length;
    }
    if (page.size < pageSize) break;
  }
  await alert.ref.update({ fannedOut: true });
  return { created, done: true };
}

export type DeliveryRow = { id: string; ref: DocumentReference; doc: DeliveryDoc };

/** The oldest pending deliveries, at most `limit` (the composite index on status, createdAt). */
export async function pendingDeliveries(db: Firestore, limit: number): Promise<DeliveryRow[]> {
  const snap = await db.collection(COLLECTIONS.deliveries).where("status", "==", "pending").orderBy("createdAt", "asc").limit(limit).get();
  return snap.docs.map((doc) => ({ id: doc.id, ref: doc.ref, doc: doc.data() as DeliveryDoc }));
}

/** The users and alerts a set of deliveries name, each read once. A missing doc is null. */
export async function deliveryContext(
  db: Firestore,
  deliveries: readonly DeliveryRow[],
): Promise<{ users: Map<string, UserDoc | null>; alerts: Map<string, AlertDoc | null> }> {
  const userIds = [...new Set(deliveries.map((d) => d.doc.user))];
  const alertIds = [...new Set(deliveries.map((d) => d.doc.alertId))];
  const [userSnaps, alertSnaps] = await Promise.all([
    userIds.length ? db.getAll(...userIds.map((id) => db.collection(COLLECTIONS.users).doc(id))) : [],
    alertIds.length ? db.getAll(...alertIds.map((id) => db.collection(COLLECTIONS.alerts).doc(id))) : [],
  ]);
  return {
    users: new Map(userIds.map((id, i) => [id, userSnaps[i]!.exists ? (userSnaps[i]!.data() as UserDoc) : null])),
    alerts: new Map(alertIds.map((id, i) => [id, alertSnaps[i]!.exists ? (alertSnaps[i]!.data() as AlertDoc) : null])),
  };
}

/** Writes a delivery's outcome. */
export async function markDelivery(delivery: DeliveryRow, update: Partial<DeliveryDoc>): Promise<void> {
  await delivery.ref.update(update);
}

/**
 * Takes the chat off the wallet, if it is still the one the delivery was sent to: a wallet that relinked to another
 * chat since the send keeps the new one. A wallet without a user doc has nothing to clear.
 */
export async function unlinkChatIfSame(db: Firestore, user: Address, chatId: number): Promise<boolean> {
  const ref = db.collection(COLLECTIONS.users).doc(user);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const current = (snap.data() as Partial<UserDoc>).telegram;
    if (current == null || current.chatId !== chatId) return false;
    tx.update(ref, { telegram: null });
    return true;
  });
}

/**
 * A watchState doc that counts no watchers should have been deleted with its last one. If no watch names the token
 * any more, delete it; one that does is left alone (the count is the transactions' to fix). Returns whether it was deleted.
 */
export async function healState(db: Firestore, state: WatchStateRow): Promise<boolean> {
  const { network, token } = state.doc;
  const any = await db.collection(COLLECTIONS.watches).where("network", "==", network).where("token", "==", token).limit(1).get();
  if (!any.empty) return false;
  try {
    await state.ref.delete({ exists: true });
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
  return true;
}
