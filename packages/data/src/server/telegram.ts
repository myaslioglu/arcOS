import { createHash, randomBytes } from "node:crypto";
import { Timestamp, type Firestore } from "firebase-admin/firestore";
import type { Address } from "@arcos/chain";
import type { LinkCodeDoc, UserDoc } from "../docs";
import { DataError } from "../errors";
import { userId } from "../ids";
import { COLLECTIONS, TTL_MS } from "../names";
import { isExpired } from "../timestamps";
import { arcosDb } from "./db";

// The Telegram link store (design 1.5): a link code the site hands a signed-in wallet, which the bot's /start brings
// back with a chat id. The code is 128 random bits and lives TTL_MS.linkCodes; only its hash is stored, so a read of the
// collection links nothing. A wallet has at most one chat, and relinking replaces it; a chat may serve several wallets.
// Nothing here logs: a doc path holds a wallet address, and a chat id names a person.

/** 16 random bytes as base64url: 22 characters of A-Za-z0-9_-, what the webhook's /start accepts. */
const LINK_CODE = /^[A-Za-z0-9_-]{22}$/;

export type ConsumeLinkCodeResult = { ok: true; address: Address } | { ok: false };

/** linkCodes/{sha256(code) as base64url}: the id a code is stored under. */
export const linkCodeId = (code: string): string => createHash("sha256").update(code, "utf8").digest("base64url");

const assertChatId = (chatId: number): number => {
  if (!Number.isSafeInteger(chatId)) throw new DataError("chat-id", "Not a chat id: expected a safe integer");
  return chatId;
};

/**
 * Makes a link code for a wallet, valid for TTL_MS.linkCodes, and stores its hash with the wallet. Returns the code:
 * the only copy of it there is.
 */
export async function createLinkCode(address: string, now: Date, db: Firestore = arcosDb()): Promise<string> {
  const code = randomBytes(16).toString("base64url");
  const doc: LinkCodeDoc = { address: userId(address), expiresAt: Timestamp.fromMillis(now.getTime() + TTL_MS.linkCodes) };
  await db.collection(COLLECTIONS.linkCodes).doc(linkCodeId(code)).set(doc);
  return code;
}

/**
 * Links a chat to the wallet a code was made for, in one transaction that deletes the code whatever happens next: a
 * code is only ever tried once. A code that was never issued, was used, has expired, or names a wallet without a user
 * doc answers `{ ok: false }`. Otherwise users/{address}.telegram becomes this chat (an earlier chat is replaced), the
 * session version is untouched, and the wallet is answered. A transaction that loses a race is retried and finds the
 * code gone, so one code links at most once.
 */
export async function consumeLinkCode(code: string, chatId: number, now: Date, db: Firestore = arcosDb()): Promise<ConsumeLinkCodeResult> {
  assertChatId(chatId);
  if (typeof code !== "string" || !LINK_CODE.test(code)) return { ok: false };
  const codeRef = db.collection(COLLECTIONS.linkCodes).doc(linkCodeId(code));

  return db.runTransaction(async (tx): Promise<ConsumeLinkCodeResult> => {
    const codeSnap = await tx.get(codeRef);
    if (!codeSnap.exists) return { ok: false };
    const stored = codeSnap.data() as Partial<LinkCodeDoc>;
    const address = typeof stored.address === "string" ? userId(stored.address) : null;
    const userRef = address === null ? null : db.collection(COLLECTIONS.users).doc(address);
    // Every read before any write: a transaction's rule.
    const userSnap = userRef === null ? null : await tx.get(userRef);

    tx.delete(codeRef);
    if (address === null || userRef === null || !stored.expiresAt || isExpired(stored.expiresAt, now)) return { ok: false };
    if (!userSnap?.exists) return { ok: false };
    const telegram: UserDoc["telegram"] = { chatId, linkedAt: Timestamp.fromDate(now) };
    tx.update(userRef, { telegram });
    return { ok: true, address };
  });
}

/** Takes the wallet's chat away, if it has one. A wallet without a user doc has no chat, and nothing is created. */
export async function unlinkWallet(address: string, db: Firestore = arcosDb()): Promise<void> {
  const ref = db.collection(COLLECTIONS.users).doc(userId(address));
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    tx.update(ref, { telegram: null });
  });
}

/** How many wallets one query takes off a chat, and how many queries one /stop may run: a chat serves a few wallets, never a crowd. */
const UNLINK_CHAT_LIMIT = 20;
const UNLINK_CHAT_ROUNDS = 5;

/**
 * Takes every wallet off a chat (the bot's /stop): a query on users.telegram.chatId (a single-field index), then one
 * batch, again while a query comes back full, at most UNLINK_CHAT_ROUNDS times. Each batch clears what the query
 * found, so the same query pages by itself. Returns how many wallets were unlinked.
 */
export async function unlinkChat(chatId: number, db: Firestore = arcosDb()): Promise<number> {
  const query = db.collection(COLLECTIONS.users).where("telegram.chatId", "==", assertChatId(chatId)).limit(UNLINK_CHAT_LIMIT);
  let count = 0;
  for (let round = 0; round < UNLINK_CHAT_ROUNDS; round++) {
    const snap = await query.get();
    if (snap.empty) break;
    const batch = db.batch();
    for (const doc of snap.docs) batch.update(doc.ref, { telegram: null });
    await batch.commit();
    count += snap.size;
    if (snap.size < UNLINK_CHAT_LIMIT) break;
  }
  return count;
}
