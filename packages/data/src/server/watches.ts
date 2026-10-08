import { Timestamp, type Firestore } from "firebase-admin/firestore";
import type { Address, NetworkId } from "@arcos/chain";
import type { AlertDoc, AlertKind, TokenDoc, UserDoc, WatchDoc, WatchStateDoc } from "../docs";
import { assertNetwork, normalizeAddress, tokenId, userId, watchId } from "../ids";
import { COLLECTIONS, FREE_WATCH_LIMIT } from "../names";
import type { TimestampLike } from "../timestamps";
import { alertText, sanitizeSymbol } from "../watch";
import { arcosDb } from "./db";

// The watch store (design 1.4): watches/{user}:{network}:{token}, the watchState doc the indexer checks, and
// users.watchCount, the free tier's lock. Every change is one transaction that reads first, so two adds by one wallet
// serialise on the users doc and the limit holds. Nothing here logs: a doc path holds a wallet address.

export type AddWatchResult = { kind: "added" | "exists" | "limit" | "no-user" };
export type RemoveWatchResult = { kind: "removed" | "absent" };

/** One row of a wallet's watch list: the token, how it labels itself, and its latest alert in words. */
export type WatchListing = {
  token: Address;
  symbol: string | null;
  addedAt: TimestampLike;
  latestAlert: { kind: AlertKind; block: number; at: TimestampLike; text: string; link: string } | null;
};

const countOf = (doc: Partial<UserDoc> | undefined): number => {
  const count = doc?.watchCount;
  return typeof count === "number" && Number.isSafeInteger(count) && count > 0 ? count : 0;
};

/**
 * Adds a watch, within FREE_WATCH_LIMIT, in one transaction: reads users/{user}, the watch, the wallet's watches and the
 * token's watchState, then creates the watch, counts the wallet on watchState (creating it unseen, at block 0, when it
 * is the first), and writes users.watchCount. A wallet without a user doc (never signed in) gets "no-user"; a watch
 * that exists "exists"; a wallet at the limit "limit". The watch count comes from the query, not the stored count, so
 * the stored count can never lock a wallet out.
 */
export async function addWatch(
  input: { user: string; network: NetworkId; token: string; now: Date },
  db: Firestore = arcosDb(),
): Promise<AddWatchResult> {
  const network = assertNetwork(input.network);
  const user = userId(input.user);
  const token = normalizeAddress(input.token);
  const userRef = db.collection(COLLECTIONS.users).doc(user);
  const watchRef = db.collection(COLLECTIONS.watches).doc(watchId(user, network, token));
  const stateRef = db.collection(COLLECTIONS.watchState).doc(tokenId(network, token));
  const owned = db.collection(COLLECTIONS.watches).where("user", "==", user).limit(FREE_WATCH_LIMIT + 1);
  const now = Timestamp.fromDate(input.now);

  return db.runTransaction(async (tx): Promise<AddWatchResult> => {
    const [userSnap, watchSnap, ownedSnap, stateSnap] = await Promise.all([tx.get(userRef), tx.get(watchRef), tx.get(owned), tx.get(stateRef)]);
    if (!userSnap.exists) return { kind: "no-user" };
    if (watchSnap.exists) return { kind: "exists" };
    const count = ownedSnap.size;
    if (count >= FREE_WATCH_LIMIT) return { kind: "limit" };

    const watch: WatchDoc = { user, network, token, createdAt: now };
    tx.create(watchRef, watch);
    if (stateSnap.exists) {
      tx.update(stateRef, { watchers: ((stateSnap.data() as Partial<WatchStateDoc>).watchers ?? 0) + 1 });
    } else {
      const state: WatchStateDoc = {
        network,
        token,
        owner: null,
        totalSupply: null,
        paused: null,
        implementation: null,
        bestPool: null,
        bestPoolDepth: null,
        checkedBlock: 0,
        watchers: 1,
        lastCheckedAt: Timestamp.fromMillis(0),
      };
      tx.create(stateRef, state);
    }
    tx.update(userRef, { watchCount: count + 1 });
    return { kind: "added" };
  });
}

/**
 * Removes a watch in one transaction: deletes it, takes the wallet off watchState (deleting the doc with its last
 * watcher, so the indexer stops checking the token), and writes users.watchCount down, never below 0. A watch that
 * isn't there is "absent", and nothing changes.
 */
export async function removeWatch(
  input: { user: string; network: NetworkId; token: string },
  db: Firestore = arcosDb(),
): Promise<RemoveWatchResult> {
  const network = assertNetwork(input.network);
  const user = userId(input.user);
  const token = normalizeAddress(input.token);
  const userRef = db.collection(COLLECTIONS.users).doc(user);
  const watchRef = db.collection(COLLECTIONS.watches).doc(watchId(user, network, token));
  const stateRef = db.collection(COLLECTIONS.watchState).doc(tokenId(network, token));

  return db.runTransaction(async (tx): Promise<RemoveWatchResult> => {
    const [watchSnap, stateSnap, userSnap] = await Promise.all([tx.get(watchRef), tx.get(stateRef), tx.get(userRef)]);
    if (!watchSnap.exists) return { kind: "absent" };
    tx.delete(watchRef);
    if (stateSnap.exists) {
      const watchers = (stateSnap.data() as Partial<WatchStateDoc>).watchers ?? 0;
      if (watchers <= 1) tx.delete(stateRef);
      else tx.update(stateRef, { watchers: watchers - 1 });
    }
    if (userSnap.exists) tx.update(userRef, { watchCount: Math.max(0, countOf(userSnap.data() as Partial<UserDoc>) - 1) });
    return { kind: "removed" };
  });
}

/** How many watches a listing reads: the free limit with room to spare, never a wallet's whole history. */
const LIST_LIMIT = 10;

/**
 * A wallet's watches on `network`, newest first, each with the token's symbol (as the index knows it) and its latest
 * alert in words. Reads: the watches (one query, on the watches(user, createdAt) index), the tokens docs (one getAll)
 * and one query per token for its newest alert (on the alerts(network, token, createdAt) index).
 */
export async function listWatches(user: string, network: NetworkId, db: Firestore = arcosDb()): Promise<WatchListing[]> {
  const net = assertNetwork(network);
  const snap = await db
    .collection(COLLECTIONS.watches)
    .where("user", "==", userId(user))
    .orderBy("createdAt", "desc")
    .limit(LIST_LIMIT)
    .get();
  const watches = snap.docs.map((doc) => doc.data() as WatchDoc).filter((watch) => watch.network === net);
  if (watches.length === 0) return [];

  const tokenSnaps = await db.getAll(...watches.map((watch) => db.collection(COLLECTIONS.tokens).doc(tokenId(net, watch.token))));
  const alerts = await Promise.all(
    watches.map((watch) =>
      db
        .collection(COLLECTIONS.alerts)
        .where("network", "==", net)
        .where("token", "==", watch.token)
        .orderBy("createdAt", "desc")
        .limit(1)
        .get(),
    ),
  );

  return watches.map((watch, i): WatchListing => {
    const tokenSnap = tokenSnaps[i];
    const tokenDoc = tokenSnap?.exists ? (tokenSnap.data() as Partial<TokenDoc>) : undefined;
    const alert = alerts[i]?.docs[0]?.data() as AlertDoc | undefined;
    return {
      token: watch.token,
      symbol: sanitizeSymbol(tokenDoc?.symbol),
      addedAt: watch.createdAt,
      latestAlert: alert
        ? { kind: alert.kind, block: alert.block, at: alert.createdAt, ...alertText({ kind: alert.kind, token: alert.token, network: net, block: alert.block, detail: alert.detail }) }
        : null,
    };
  });
}
