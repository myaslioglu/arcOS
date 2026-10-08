import { deleteApp, getApps } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import { afterAll, describe, expect, it } from "vitest";
import type { Address } from "@arcos/chain";
import {
  COLLECTIONS,
  FREE_WATCH_LIMIT,
  TTL_MS,
  tokenId,
  watchId,
  type AlertDoc,
  type TokenDoc,
  type UserDoc,
  type WatchDoc,
  type WatchStateDoc,
} from "../index";
import { addWatch, arcosDb, listWatches, removeWatch } from "../server";

// The watch store (design 1.4): watches/{user}:{network}:{token}, watchState/{network}:{token} with its watchers count,
// and users.watchCount, all kept in step by one transaction per change.

let sequence = 0;
const address = (): Address => `0x${(Date.now().toString(16) + (sequence++).toString(16)).padStart(40, "0")}`;
const NOW = new Date("2026-10-08T12:00:00.000Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);

afterAll(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

const db = () => arcosDb();
const users = () => db().collection(COLLECTIONS.users);
const watchState = (token: string) => db().collection(COLLECTIONS.watchState).doc(tokenId("mainnet", token));
const watchDoc = (user: string, token: string) => db().collection(COLLECTIONS.watches).doc(watchId(user, "mainnet", token));

/** A wallet that has signed in: addWatch needs the user doc. */
async function signedIn(watchCount?: number): Promise<string> {
  const user = address();
  const doc: UserDoc = { address: user, telegram: null, createdAt: Timestamp.fromDate(NOW), lastSignInAt: Timestamp.fromDate(NOW), sessionVersion: 0 };
  await users().doc(user).set(watchCount === undefined ? doc : { ...doc, watchCount });
  return user;
}

const watchCountOf = async (user: string) => ((await users().doc(user).get()).data() as UserDoc).watchCount;
const watchersOf = async (token: string) => ((await watchState(token).get()).data() as WatchStateDoc | undefined)?.watchers;

describe("addWatch", () => {
  it("creates the watch, an unseen watchState and the wallet's count", async () => {
    const user = signedIn();
    const token = address();
    await expect(addWatch({ user: await user, network: "mainnet", token, now: NOW })).resolves.toEqual({ kind: "added" });

    const watch = (await watchDoc(await user, token).get()).data() as WatchDoc;
    expect(watch).toEqual({ user: await user, network: "mainnet", token, createdAt: Timestamp.fromDate(NOW) });

    const state = (await watchState(token).get()).data() as WatchStateDoc;
    expect(state).toEqual({
      network: "mainnet",
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
    });
    expect(await watchCountOf(await user)).toBe(1);
  });

  it("lowercases the wallet and the token", async () => {
    const user = await signedIn();
    const token = address();
    const mixed = (a: string) => `0x${a.slice(2).toUpperCase()}`;
    await expect(addWatch({ user: mixed(user), network: "mainnet", token: mixed(token), now: NOW })).resolves.toEqual({ kind: "added" });
    expect((await watchDoc(user, token).get()).exists).toBe(true);
    expect((await watchState(token).get()).exists).toBe(true);
  });

  it("refuses a wallet that never signed in, and writes nothing", async () => {
    const user = address();
    const token = address();
    await expect(addWatch({ user, network: "mainnet", token, now: NOW })).resolves.toEqual({ kind: "no-user" });
    expect((await watchDoc(user, token).get()).exists).toBe(false);
    expect((await watchState(token).get()).exists).toBe(false);
    expect((await users().doc(user).get()).exists).toBe(false);
  });

  it("lets a wallet watch three tokens and refuses the fourth", async () => {
    const user = await signedIn();
    const tokens = Array.from({ length: FREE_WATCH_LIMIT + 1 }, () => address());
    for (const token of tokens.slice(0, FREE_WATCH_LIMIT)) {
      await expect(addWatch({ user, network: "mainnet", token, now: NOW })).resolves.toEqual({ kind: "added" });
    }
    await expect(addWatch({ user, network: "mainnet", token: tokens[FREE_WATCH_LIMIT]!, now: NOW })).resolves.toEqual({ kind: "limit" });
    expect((await watchDoc(user, tokens[FREE_WATCH_LIMIT]!).get()).exists).toBe(false);
    expect((await watchState(tokens[FREE_WATCH_LIMIT]!).get()).exists).toBe(false);
    expect(await watchCountOf(user)).toBe(FREE_WATCH_LIMIT);
  });

  it("lets exactly three of five concurrent adds through, and counts three", async () => {
    const user = await signedIn();
    const tokens = Array.from({ length: 5 }, () => address());
    const results = await Promise.all(tokens.map((token) => addWatch({ user, network: "mainnet", token, now: NOW })));
    expect(results.filter((r) => r.kind === "added")).toHaveLength(FREE_WATCH_LIMIT);
    expect(results.filter((r) => r.kind === "limit")).toHaveLength(5 - FREE_WATCH_LIMIT);
    const owned = await db().collection(COLLECTIONS.watches).where("user", "==", user).get();
    expect(owned.size).toBe(FREE_WATCH_LIMIT);
    expect(await watchCountOf(user)).toBe(FREE_WATCH_LIMIT);
  });

  it("answers exists for a token already watched, with the counters unchanged", async () => {
    const user = await signedIn();
    const token = address();
    await addWatch({ user, network: "mainnet", token, now: NOW });
    await expect(addWatch({ user, network: "mainnet", token, now: later(1000) })).resolves.toEqual({ kind: "exists" });
    expect(await watchersOf(token)).toBe(1);
    expect(await watchCountOf(user)).toBe(1);
    expect(((await watchDoc(user, token).get()).data() as WatchDoc).createdAt.toMillis()).toBe(NOW.getTime());
  });

  it("counts the watches that exist, not the stored count, so a stale count never locks a wallet out", async () => {
    const user = await signedIn(FREE_WATCH_LIMIT);
    await expect(addWatch({ user, network: "mainnet", token: address(), now: NOW })).resolves.toEqual({ kind: "added" });
    expect(await watchCountOf(user)).toBe(1);
  });

  it("refuses a value that is not an address, or not a network, before touching the database", async () => {
    const user = await signedIn();
    await expect(addWatch({ user, network: "mainnet", token: "0x123", now: NOW })).rejects.toMatchObject({ code: "address" });
    await expect(addWatch({ user, network: "devnet" as never, token: address(), now: NOW })).rejects.toMatchObject({ code: "network" });
    expect(await watchCountOf(user)).toBeUndefined();
  });
});

describe("two wallets on one token", () => {
  it("count up to two watchers, down to one, and then the doc is deleted", async () => {
    const [a, b] = await Promise.all([signedIn(), signedIn()]);
    const token = address();
    await addWatch({ user: a, network: "mainnet", token, now: NOW });
    await addWatch({ user: b, network: "mainnet", token, now: NOW });
    expect(await watchersOf(token)).toBe(2);

    await expect(removeWatch({ user: a, network: "mainnet", token })).resolves.toEqual({ kind: "removed" });
    expect(await watchersOf(token)).toBe(1);
    expect((await watchDoc(a, token).get()).exists).toBe(false);
    expect((await watchDoc(b, token).get()).exists).toBe(true);
    expect(await watchCountOf(a)).toBe(0);
    expect(await watchCountOf(b)).toBe(1);

    await expect(removeWatch({ user: b, network: "mainnet", token })).resolves.toEqual({ kind: "removed" });
    expect((await watchState(token).get()).exists).toBe(false);
    expect(await watchCountOf(b)).toBe(0);
  });

  it("keeps the watchState the indexer filled in while a watcher remains", async () => {
    const [a, b] = await Promise.all([signedIn(), signedIn()]);
    const token = address();
    await addWatch({ user: a, network: "mainnet", token, now: NOW });
    await addWatch({ user: b, network: "mainnet", token, now: NOW });
    await watchState(token).update({ owner: a, checkedBlock: 500, totalSupply: "1000" });
    await removeWatch({ user: a, network: "mainnet", token });
    expect((await watchState(token).get()).data()).toMatchObject({ owner: a, checkedBlock: 500, totalSupply: "1000", watchers: 1 });
  });
});

describe("removeWatch", () => {
  it("is a no-op for a watch that isn't there", async () => {
    const user = await signedIn(2);
    const token = address();
    await expect(removeWatch({ user, network: "mainnet", token })).resolves.toEqual({ kind: "absent" });
    expect(await watchCountOf(user)).toBe(2);
    expect((await watchState(token).get()).exists).toBe(false);
  });

  it("never counts below zero, and copes with a user doc that is gone", async () => {
    const user = await signedIn();
    const token = address();
    await addWatch({ user, network: "mainnet", token, now: NOW });
    await users().doc(user).update({ watchCount: 0 });
    await expect(removeWatch({ user, network: "mainnet", token })).resolves.toEqual({ kind: "removed" });
    expect(await watchCountOf(user)).toBe(0);

    const other = await signedIn();
    const second = address();
    await addWatch({ user: other, network: "mainnet", token: second, now: NOW });
    await users().doc(other).delete();
    await expect(removeWatch({ user: other, network: "mainnet", token: second })).resolves.toEqual({ kind: "removed" });
    expect((await watchDoc(other, second).get()).exists).toBe(false);
    expect((await users().doc(other).get()).exists).toBe(false);
  });

  it("lets the wallet add again after removing at the limit", async () => {
    const user = await signedIn();
    const tokens = Array.from({ length: FREE_WATCH_LIMIT + 1 }, () => address());
    for (const token of tokens.slice(0, FREE_WATCH_LIMIT)) await addWatch({ user, network: "mainnet", token, now: NOW });
    await removeWatch({ user, network: "mainnet", token: tokens[0]! });
    await expect(addWatch({ user, network: "mainnet", token: tokens[FREE_WATCH_LIMIT]!, now: NOW })).resolves.toEqual({ kind: "added" });
    expect(await watchCountOf(user)).toBe(FREE_WATCH_LIMIT);
  });
});

describe("listWatches", () => {
  const tokenDoc = (token: Address, symbol: string | null): TokenDoc => ({
    network: "mainnet",
    address: token,
    name: null,
    symbol,
    decimals: 18,
    totalSupply: null,
    source: "factory",
    creator: null,
    firstBlock: 1,
    firstSeen: Timestamp.fromDate(NOW),
    bestPool: null,
    report: null,
    radar: { liquid: false, passing: false },
    inspect: { state: "done", priority: 0, attempts: 1, queuedAt: null },
    launchpad: null,
  });
  const alertDoc = (token: Address, block: number, at: Date, over: Partial<AlertDoc> = {}): AlertDoc => ({
    network: "mainnet",
    token,
    kind: "paused",
    detail: { symbol: "WDG", decimals: 18, from: null, to: null, quote: null, pool: null, renounced: false, pct: null },
    block,
    createdAt: Timestamp.fromDate(at),
    expiresAt: Timestamp.fromMillis(at.getTime() + TTL_MS.alerts),
    fannedOut: true,
    ...over,
  });

  it("lists nothing for a wallet with no watches", async () => {
    await expect(listWatches(await signedIn(), "mainnet")).resolves.toEqual([]);
    await expect(listWatches(address(), "mainnet")).resolves.toEqual([]);
  });

  it("lists the watches newest first, with the token's symbol and no alert yet", async () => {
    const user = await signedIn();
    const [first, second] = [address(), address()];
    await db().collection(COLLECTIONS.tokens).doc(tokenId("mainnet", first)).set(tokenDoc(first, "ONE"));
    await addWatch({ user, network: "mainnet", token: first, now: NOW });
    await addWatch({ user, network: "mainnet", token: second, now: later(1000) });

    const listed = await listWatches(user, "mainnet");
    expect(listed.map((w) => w.token)).toEqual([second, first]);
    expect(listed[0]).toEqual({ token: second, symbol: null, addedAt: Timestamp.fromDate(later(1000)), latestAlert: null });
    expect(listed[1]).toEqual({ token: first, symbol: "ONE", addedAt: Timestamp.fromDate(NOW), latestAlert: null });
  });

  it("returns the newest alert of each token, in words, and never another token's", async () => {
    const user = await signedIn();
    const token = address();
    const other = address();
    const short = `${token.slice(0, 6)}…${token.slice(-4)}`;
    await db().collection(COLLECTIONS.tokens).doc(tokenId("mainnet", token)).set(tokenDoc(token, "WDG"));
    await addWatch({ user, network: "mainnet", token, now: NOW });
    await addWatch({ user, network: "mainnet", token: other, now: NOW });
    await db().collection(COLLECTIONS.alerts).add(alertDoc(token, 1000, later(10_000)));
    await db().collection(COLLECTIONS.alerts).add(alertDoc(token, 1500, later(20_000), { kind: "unpaused" }));
    await db().collection(COLLECTIONS.alerts).add(alertDoc(token, 1200, later(15_000)));
    await db().collection(COLLECTIONS.alerts).add(alertDoc(other, 9000, later(30_000)));

    const listed = await listWatches(user, "mainnet");
    const watched = listed.find((w) => w.token === token);
    expect(watched?.latestAlert).toEqual({
      kind: "unpaused",
      block: 1500,
      at: Timestamp.fromDate(later(20_000)),
      text: `WDG (${short}): unpaused at block 1,500`,
      link: `https://explorer.arc.io/token/${token}`,
    });
    expect(listed.find((w) => w.token === other)?.latestAlert).toMatchObject({ kind: "paused", block: 9000 });
  });

  it("shows a token's symbol as sanitised, so a stored override never reaches the list", async () => {
    const user = await signedIn();
    const token = address();
    await db().collection(COLLECTIONS.tokens).doc(tokenId("mainnet", token)).set(tokenDoc(token, "WDG‮\n"));
    await addWatch({ user, network: "mainnet", token, now: NOW });
    expect((await listWatches(user, "mainnet"))[0]?.symbol).toBe("WDG");
  });

  it("lists one network's watches only, and never another wallet's", async () => {
    const [a, b] = await Promise.all([signedIn(), signedIn()]);
    const token = address();
    await addWatch({ user: a, network: "mainnet", token, now: NOW });
    await addWatch({ user: b, network: "mainnet", token: address(), now: NOW });
    await expect(listWatches(a, "testnet")).resolves.toEqual([]);
    expect((await listWatches(a, "mainnet")).map((w) => w.token)).toEqual([token]);
  });
});
