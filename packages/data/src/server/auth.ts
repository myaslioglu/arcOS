import { Timestamp, type Firestore } from "firebase-admin/firestore";
import type { NonceDoc, UserDoc } from "../docs";
import { nonceId, userId } from "../ids";
import { COLLECTIONS, TTL_MS } from "../names";
import { isExpired } from "../timestamps";
import { arcosDb } from "./db";

// The sign-in store of design 1.4: nonces/{nonce}, which live 10 minutes and are deleted in the transaction that
// accepts one, and users/{address}, whose sessionVersion decides which session cookies still count. Nothing here logs:
// a doc path holds a wallet address, and addresses never reach a log line.

export type SignInResult = { ok: true; sessionVersion: number } | { ok: false };
export type SessionState = { sessionVersion: number; telegramLinked: boolean };

const versionOf = (doc: Partial<UserDoc> | undefined): number => {
  const version = doc?.sessionVersion;
  return typeof version === "number" && Number.isSafeInteger(version) && version >= 0 ? version : 0;
};

/**
 * Stores a nonce the server just made, valid for TTL_MS.nonces. `create` fails if the doc exists, so a nonce is never
 * issued twice.
 */
export async function storeNonce(nonce: string, now: Date, db: Firestore = arcosDb()): Promise<void> {
  const doc: NonceDoc = { expiresAt: Timestamp.fromMillis(now.getTime() + TTL_MS.nonces) };
  await db.collection(COLLECTIONS.nonces).doc(nonceId(nonce)).create(doc);
}

/**
 * Whether a nonce is stored and unexpired, read without consuming it. Verify asks this before it spends an RPC call on
 * a signature, so a nonce never issued, or already used, costs one read. It decides nothing: acceptSignIn's
 * transaction still reads and deletes the nonce, and only it lets a sign-in through.
 */
export async function isNonceLive(nonce: string, now: Date, db: Firestore = arcosDb()): Promise<boolean> {
  const snap = await db.collection(COLLECTIONS.nonces).doc(nonceId(nonce)).get();
  if (!snap.exists) return false;
  const stored = snap.data() as Partial<NonceDoc>;
  return stored.expiresAt !== undefined && !isExpired(stored.expiresAt, now);
}

/**
 * Accepts a sign-in whose signature the caller has already verified. In one transaction it reads the nonce, deletes it
 * (expired or not: a nonce is only ever tried once), and, when it was stored and has not expired, creates or updates
 * users/{address} and answers the user's session version. A nonce that is missing, used or expired answers
 * `{ ok: false }`. Firestore retries a transaction that loses a race, and the retry finds the nonce gone, so one nonce
 * signs in at most once.
 */
export async function acceptSignIn(
  input: { nonce: string; address: string; now: Date },
  db: Firestore = arcosDb(),
): Promise<SignInResult> {
  const nonceRef = db.collection(COLLECTIONS.nonces).doc(nonceId(input.nonce));
  const address = userId(input.address);
  const userRef = db.collection(COLLECTIONS.users).doc(address);
  const now = Timestamp.fromDate(input.now);

  return db.runTransaction(async (tx) => {
    const [nonceSnap, userSnap] = await Promise.all([tx.get(nonceRef), tx.get(userRef)]);
    if (!nonceSnap.exists) return { ok: false } as const;
    tx.delete(nonceRef);
    const stored = nonceSnap.data() as Partial<NonceDoc>;
    if (!stored.expiresAt || isExpired(stored.expiresAt, input.now)) return { ok: false } as const;

    const existing = userSnap.data() as Partial<UserDoc> | undefined;
    const sessionVersion = versionOf(existing);
    if (existing) {
      tx.update(userRef, { lastSignInAt: now, sessionVersion });
    } else {
      const created: UserDoc = { address, telegram: null, createdAt: now, lastSignInAt: now, sessionVersion };
      tx.create(userRef, created);
    }
    return { ok: true, sessionVersion } as const;
  });
}

/** What a session check needs from users/{address}, or null when the wallet has no user doc. */
export async function readSessionState(address: string, db: Firestore = arcosDb()): Promise<SessionState | null> {
  const snap = await db.collection(COLLECTIONS.users).doc(userId(address)).get();
  if (!snap.exists) return null;
  const doc = snap.data() as Partial<UserDoc>;
  return { sessionVersion: versionOf(doc), telegramLinked: doc.telegram != null };
}

/**
 * Ends every session of a wallet: the version moves on, so each cookie signed with an earlier one stops counting. A
 * wallet without a user doc has no session that could count, and nothing is created for it.
 */
export async function revokeSessions(address: string, db: Firestore = arcosDb()): Promise<void> {
  const ref = db.collection(COLLECTIONS.users).doc(userId(address));
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    tx.update(ref, { sessionVersion: versionOf(snap.data() as Partial<UserDoc>) + 1 });
  });
}
