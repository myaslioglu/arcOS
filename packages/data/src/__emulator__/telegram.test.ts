import { deleteApp, getApps } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import { afterAll, describe, expect, it } from "vitest";
import type { Address } from "@arcos/chain";
import { COLLECTIONS, TTL_MS, type LinkCodeDoc, type UserDoc } from "../index";
import { arcosDb, consumeLinkCode, createLinkCode, linkCodeId, unlinkChat, unlinkWallet } from "../server";

// The Telegram link store (design 1.5): linkCodes/{sha256(code)} for ten minutes, consumed once in a transaction that
// writes users.telegram, and the two ways out of a link.

let sequence = 0;
const address = (): Address => `0x${(Date.now().toString(16) + (sequence++).toString(16)).padStart(40, "0")}`;
const chat = () => Number(`${Date.now() % 10_000_000}${(sequence++ % 1000).toString().padStart(3, "0")}`);
const NOW = new Date("2026-10-08T12:00:00.000Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);

afterAll(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

const users = () => arcosDb().collection(COLLECTIONS.users);
const codes = () => arcosDb().collection(COLLECTIONS.linkCodes);

async function signedIn(sessionVersion = 0): Promise<string> {
  const user = address();
  const doc: UserDoc = { address: user, telegram: null, createdAt: Timestamp.fromDate(NOW), lastSignInAt: Timestamp.fromDate(NOW), sessionVersion };
  await users().doc(user).set(doc);
  return user;
}

const userDoc = async (user: string) => (await users().doc(user).get()).data() as UserDoc;

describe("createLinkCode", () => {
  it("returns 22 characters of A-Za-z0-9_- and stores only their hash, with the wallet and a ten-minute expiry", async () => {
    const user = await signedIn();
    const code = await createLinkCode(user, NOW);
    expect(code).toMatch(/^[A-Za-z0-9_-]{22}$/);

    expect((await codes().doc(code).get()).exists).toBe(false);
    const stored = (await codes().doc(linkCodeId(code)).get()).data() as LinkCodeDoc;
    expect(Object.keys(stored).sort()).toEqual(["address", "expiresAt"]);
    expect(stored.address).toBe(user);
    expect(stored.expiresAt.toMillis()).toBe(NOW.getTime() + TTL_MS.linkCodes);
  });

  it("makes a different code each time, and lowercases the wallet", async () => {
    const user = await signedIn();
    const mixed = `0x${user.slice(2).toUpperCase()}`;
    const [a, b] = await Promise.all([createLinkCode(mixed, NOW), createLinkCode(mixed, NOW)]);
    expect(a).not.toBe(b);
    expect(((await codes().doc(linkCodeId(a)).get()).data() as LinkCodeDoc).address).toBe(user);
  });

  it("hashes with sha256 as base64url", () => {
    expect(linkCodeId("AAAAAAAAAAAAAAAAAAAAAA")).toBe("ilvbTMFRZBJsbvJmjendJA0pnOY5ekLJWpQRuT0IDtg");
    expect(linkCodeId("AAAAAAAAAAAAAAAAAAAAAA")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("consumeLinkCode", () => {
  it("links the chat once: the code is deleted, telegram is set, and a second consume answers false", async () => {
    const user = await signedIn();
    const chatId = chat();
    const code = await createLinkCode(user, NOW);

    await expect(consumeLinkCode(code, chatId, later(60_000))).resolves.toEqual({ ok: true, address: user });
    expect((await codes().doc(linkCodeId(code)).get()).exists).toBe(false);
    const doc = await userDoc(user);
    expect(doc.telegram).toEqual({ chatId, linkedAt: Timestamp.fromDate(later(60_000)) });

    await expect(consumeLinkCode(code, chat(), later(61_000))).resolves.toEqual({ ok: false });
    expect((await userDoc(user)).telegram?.chatId).toBe(chatId);
  });

  it("answers false for an expired code, checking expiry itself, and deletes it", async () => {
    const user = await signedIn();
    const code = await createLinkCode(user, NOW);
    await expect(consumeLinkCode(code, chat(), later(TTL_MS.linkCodes))).resolves.toEqual({ ok: false });
    expect((await codes().doc(linkCodeId(code)).get()).exists).toBe(false);
    expect((await userDoc(user)).telegram).toBeNull();
  });

  it("answers false for a code never issued, and for one that isn't a code at all, without writing", async () => {
    await expect(consumeLinkCode("AAAAAAAAAAAAAAAAAAAAAA", chat(), NOW)).resolves.toEqual({ ok: false });
    await expect(consumeLinkCode("", chat(), NOW)).resolves.toEqual({ ok: false });
    await expect(consumeLinkCode("not a code", chat(), NOW)).resolves.toEqual({ ok: false });
    await expect(consumeLinkCode("AAAAAAAAAAAAAAAAAAAAAAA", chat(), NOW)).resolves.toEqual({ ok: false });
  });

  it("answers false for a wallet without a user doc, and still deletes the code", async () => {
    const user = address();
    const code = await createLinkCode(user, NOW);
    await expect(consumeLinkCode(code, chat(), NOW)).resolves.toEqual({ ok: false });
    expect((await codes().doc(linkCodeId(code)).get()).exists).toBe(false);
    expect((await users().doc(user).get()).exists).toBe(false);
  });

  it("refuses a chat id that isn't a safe integer before touching the database", async () => {
    const code = await createLinkCode(await signedIn(), NOW);
    await expect(consumeLinkCode(code, 1.5, NOW)).rejects.toMatchObject({ code: "chat-id" });
    await expect(consumeLinkCode(code, Number.MAX_SAFE_INTEGER + 1, NOW)).rejects.toMatchObject({ code: "chat-id" });
    await expect(consumeLinkCode(code, Number.NaN, NOW)).rejects.toMatchObject({ code: "chat-id" });
    expect((await codes().doc(linkCodeId(code)).get()).exists).toBe(true);
  });

  it("lets exactly one of several concurrent consumes of one code through", async () => {
    const user = await signedIn();
    const code = await createLinkCode(user, NOW);
    const results = await Promise.all(Array.from({ length: 5 }, () => consumeLinkCode(code, chat(), NOW)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("relinking replaces the chat", async () => {
    const user = await signedIn();
    const [first, second] = [chat(), chat()];
    await consumeLinkCode(await createLinkCode(user, NOW), first, NOW);
    await consumeLinkCode(await createLinkCode(user, later(1000)), second, later(2000));
    expect((await userDoc(user)).telegram).toEqual({ chatId: second, linkedAt: Timestamp.fromDate(later(2000)) });
  });

  it("keeps the session version, the creation time and the watch count", async () => {
    const user = await signedIn(4);
    await users().doc(user).update({ watchCount: 2 });
    await consumeLinkCode(await createLinkCode(user, NOW), chat(), later(1000));
    const doc = await userDoc(user);
    expect(doc.sessionVersion).toBe(4);
    expect(doc.watchCount).toBe(2);
    expect(doc.createdAt.toMillis()).toBe(NOW.getTime());
  });
});

describe("unlinkWallet and unlinkChat", () => {
  it("unlinkWallet clears the wallet's chat and keeps everything else", async () => {
    const user = await signedIn(2);
    await consumeLinkCode(await createLinkCode(user, NOW), chat(), NOW);
    await unlinkWallet(user);
    const doc = await userDoc(user);
    expect(doc.telegram).toBeNull();
    expect(doc.sessionVersion).toBe(2);
  });

  it("unlinkWallet creates nothing for a wallet without a user doc", async () => {
    const user = address();
    await unlinkWallet(user);
    expect((await users().doc(user).get()).exists).toBe(false);
  });

  it("unlinkChat clears every wallet linked to the chat, and no other", async () => {
    const chatId = chat();
    const otherChat = chat();
    const [a, b, c] = await Promise.all([signedIn(1), signedIn(2), signedIn(3)]);
    await consumeLinkCode(await createLinkCode(a, NOW), chatId, NOW);
    await consumeLinkCode(await createLinkCode(b, NOW), chatId, NOW);
    await consumeLinkCode(await createLinkCode(c, NOW), otherChat, NOW);

    await expect(unlinkChat(chatId)).resolves.toBe(2);
    expect((await userDoc(a)).telegram).toBeNull();
    expect((await userDoc(b)).telegram).toBeNull();
    expect((await userDoc(c)).telegram?.chatId).toBe(otherChat);
    expect((await userDoc(a)).sessionVersion).toBe(1);
    expect((await userDoc(b)).sessionVersion).toBe(2);

    await expect(unlinkChat(chatId)).resolves.toBe(0);
  });

  it("unlinkChat clears more wallets than one query holds: 21 on one chat, all unlinked in one call", async () => {
    const chatId = chat();
    const wallets = await Promise.all(Array.from({ length: 21 }, () => signedIn()));
    for (const wallet of wallets) await consumeLinkCode(await createLinkCode(wallet, NOW), chatId, NOW);

    await expect(unlinkChat(chatId)).resolves.toBe(21);
    const docs = await Promise.all(wallets.map(userDoc));
    expect(docs.every((doc) => doc.telegram === null)).toBe(true);
    await expect(unlinkChat(chatId)).resolves.toBe(0);
  });

  it("unlinkChat refuses a chat id that isn't a safe integer", async () => {
    await expect(unlinkChat(0.5)).rejects.toMatchObject({ code: "chat-id" });
  });
});
