import { deleteApp, getApps } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import { afterAll, describe, expect, it } from "vitest";
import { COLLECTIONS, TTL_MS, type NonceDoc, type UserDoc } from "../index";
import { acceptSignIn, arcosDb, isNonceLive, readSessionState, revokeSessions, storeNonce } from "../server";

// The sign-in store (design 1.4, 1.6): nonces/{nonce} with a 10-minute expiresAt, deleted in the transaction that
// accepts it, and users/{address} with the session version that logout bumps.

let sequence = 0;
/** A fresh 32-character nonce and a fresh address for each test, so no test sees another's docs. */
const nonce = () => `n${Date.now().toString(36)}${(sequence++).toString(36)}`.padEnd(32, "0");
const address = () => `0x${(Date.now().toString(16) + (sequence++).toString(16)).padStart(40, "0")}`;
const NOW = new Date("2026-09-30T12:00:00.000Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);

afterAll(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe("storeNonce", () => {
  it("writes nonces/{nonce} with expiresAt ten minutes on, in the arcos database", async () => {
    const value = nonce();
    await storeNonce(value, NOW);
    const snap = await arcosDb().collection(COLLECTIONS.nonces).doc(value).get();
    const doc = snap.data() as NonceDoc;
    expect(Object.keys(doc)).toEqual(["expiresAt"]);
    expect(doc.expiresAt).toBeInstanceOf(Timestamp);
    expect(doc.expiresAt.toMillis()).toBe(NOW.getTime() + TTL_MS.nonces);
  });

  it("never overwrites a nonce that exists", async () => {
    const value = nonce();
    await storeNonce(value, NOW);
    await expect(storeNonce(value, later(1000))).rejects.toThrow();
    const doc = (await arcosDb().collection(COLLECTIONS.nonces).doc(value).get()).data() as NonceDoc;
    expect(doc.expiresAt.toMillis()).toBe(NOW.getTime() + TTL_MS.nonces);
  });

  it("refuses a value that is not a nonce before touching the database", async () => {
    await expect(storeNonce("not/a nonce", NOW)).rejects.toMatchObject({ code: "nonce" });
  });
});

// Review 1, Important 1: verify asks whether a nonce is worth a signature check before it spends an RPC call on one.
// Asking reads, never consumes: acceptSignIn's transaction stays the only authority.
describe("isNonceLive", () => {
  it("answers true for a stored, unexpired nonce, and leaves it for acceptSignIn", async () => {
    const value = nonce();
    await storeNonce(value, NOW);
    await expect(isNonceLive(value, later(60_000))).resolves.toBe(true);
    await expect(isNonceLive(value, later(60_000))).resolves.toBe(true);
    expect((await arcosDb().collection(COLLECTIONS.nonces).doc(value).get()).exists).toBe(true);
    await expect(acceptSignIn({ nonce: value, address: address(), now: later(60_000) })).resolves.toMatchObject({ ok: true });
    await expect(isNonceLive(value, later(60_000))).resolves.toBe(false);
  });

  it("answers false for a nonce never issued, and for an expired one, which it doesn't delete", async () => {
    await expect(isNonceLive(nonce(), NOW)).resolves.toBe(false);
    const value = nonce();
    await storeNonce(value, NOW);
    await expect(isNonceLive(value, later(TTL_MS.nonces))).resolves.toBe(false);
    expect((await arcosDb().collection(COLLECTIONS.nonces).doc(value).get()).exists).toBe(true);
  });

  it("refuses a value that is not a nonce before touching the database", async () => {
    await expect(isNonceLive("not/a nonce", NOW)).rejects.toMatchObject({ code: "nonce" });
  });
});

describe("acceptSignIn", () => {
  it("accepts a stored nonce once, deletes it, and creates the user with session version 0", async () => {
    const value = nonce();
    const user = address();
    await storeNonce(value, NOW);

    await expect(acceptSignIn({ nonce: value, address: user, now: later(60_000) })).resolves.toEqual({
      ok: true,
      sessionVersion: 0,
    });
    expect((await arcosDb().collection(COLLECTIONS.nonces).doc(value).get()).exists).toBe(false);

    const doc = (await arcosDb().collection(COLLECTIONS.users).doc(user).get()).data() as UserDoc;
    expect(doc.address).toBe(user);
    expect(doc.telegram).toBeNull();
    expect(doc.sessionVersion).toBe(0);
    expect(doc.createdAt.toMillis()).toBe(later(60_000).getTime());
    expect(doc.lastSignInAt.toMillis()).toBe(later(60_000).getTime());

    // The same nonce a second time: gone, so refused.
    await expect(acceptSignIn({ nonce: value, address: user, now: later(61_000) })).resolves.toEqual({ ok: false });
  });

  it("lowercases the address it stores", async () => {
    const value = nonce();
    const user = address();
    await storeNonce(value, NOW);
    const mixed = `0x${user.slice(2).toUpperCase()}`;
    await expect(acceptSignIn({ nonce: value, address: mixed, now: NOW })).resolves.toMatchObject({ ok: true });
    expect((await arcosDb().collection(COLLECTIONS.users).doc(user).get()).exists).toBe(true);
  });

  it("refuses a nonce it never issued", async () => {
    await expect(acceptSignIn({ nonce: nonce(), address: address(), now: NOW })).resolves.toEqual({ ok: false });
  });

  it("refuses an expired nonce, checking expiry itself, and deletes it all the same", async () => {
    const value = nonce();
    const user = address();
    await storeNonce(value, NOW);
    await expect(acceptSignIn({ nonce: value, address: user, now: later(TTL_MS.nonces) })).resolves.toEqual({
      ok: false,
    });
    expect((await arcosDb().collection(COLLECTIONS.nonces).doc(value).get()).exists).toBe(false);
    expect((await arcosDb().collection(COLLECTIONS.users).doc(user).get()).exists).toBe(false);
  });

  it("lets exactly one of several concurrent sign-ins with one nonce through", async () => {
    const value = nonce();
    await storeNonce(value, NOW);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => acceptSignIn({ nonce: value, address: address(), now: NOW })),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
  });

  it("keeps the user's createdAt, Telegram link and session version on a later sign-in", async () => {
    const user = address();
    const first = nonce();
    await storeNonce(first, NOW);
    await acceptSignIn({ nonce: first, address: user, now: NOW });
    const telegram = { chatId: 12345, linkedAt: Timestamp.fromDate(NOW) };
    await arcosDb().collection(COLLECTIONS.users).doc(user).update({ telegram, sessionVersion: 3 });

    const second = nonce();
    await storeNonce(second, later(5_000));
    await expect(acceptSignIn({ nonce: second, address: user, now: later(6_000) })).resolves.toEqual({
      ok: true,
      sessionVersion: 3,
    });
    const doc = (await arcosDb().collection(COLLECTIONS.users).doc(user).get()).data() as UserDoc;
    expect(doc.createdAt.toMillis()).toBe(NOW.getTime());
    expect(doc.lastSignInAt.toMillis()).toBe(later(6_000).getTime());
    expect(doc.telegram?.chatId).toBe(12345);
    expect(doc.sessionVersion).toBe(3);
  });

  it("reads a user doc written before session versions existed as version 0", async () => {
    const user = address();
    await arcosDb()
      .collection(COLLECTIONS.users)
      .doc(user)
      .set({ address: user, telegram: null, createdAt: Timestamp.fromDate(NOW), lastSignInAt: Timestamp.fromDate(NOW) });
    const value = nonce();
    await storeNonce(value, NOW);
    await expect(acceptSignIn({ nonce: value, address: user, now: NOW })).resolves.toEqual({ ok: true, sessionVersion: 0 });
    await expect(readSessionState(user)).resolves.toEqual({ sessionVersion: 0, telegramLinked: false });
  });
});

describe("readSessionState and revokeSessions", () => {
  it("reads nothing for a wallet that never signed in", async () => {
    await expect(readSessionState(address())).resolves.toBeNull();
  });

  it("reads the version and whether Telegram is linked, and a revoke moves the version on", async () => {
    const user = address();
    const value = nonce();
    await storeNonce(value, NOW);
    await acceptSignIn({ nonce: value, address: user, now: NOW });
    await expect(readSessionState(user)).resolves.toEqual({ sessionVersion: 0, telegramLinked: false });

    await revokeSessions(user);
    await expect(readSessionState(user)).resolves.toEqual({ sessionVersion: 1, telegramLinked: false });

    await arcosDb()
      .collection(COLLECTIONS.users)
      .doc(user)
      .update({ telegram: { chatId: 1, linkedAt: Timestamp.fromDate(NOW) } });
    await revokeSessions(user);
    await expect(readSessionState(user)).resolves.toEqual({ sessionVersion: 2, telegramLinked: true });
  });

  it("revoking a wallet without a user doc creates nothing", async () => {
    const user = address();
    await revokeSessions(user);
    expect((await arcosDb().collection(COLLECTIONS.users).doc(user).get()).exists).toBe(false);
  });
});
