import { deleteApp, getApps } from "firebase-admin/app";
import { FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Address } from "@arcos/chain";
import { CallReverted, type ChainReader } from "@arcos/inspector";
import {
  COLLECTIONS,
  DATABASE_ID,
  DELIVERY_MAX_AGE_MS,
  DELIVERY_MAX_ATTEMPTS,
  TTL_MS,
  deliveryId,
  poolId,
  tokenId,
  type AlertDoc,
  type DeliveryDoc,
  type IndexerDoc,
  type PoolDoc,
  type TokenDoc,
  type UserDoc,
  type WatchStateDoc,
} from "@arcos/data";
import { addWatch, arcosDb, removeWatch } from "@arcos/data/server";
import { LIMITS, runIndexer, type Logger, type RunDeps, type RunResult } from "../indexer/run";
import type { SendOutcome, TelegramSender } from "../indexer/telegram";
import { WATCH, instancePause } from "../indexer/watch";
import { REVERT, fakeWatchReader, type Call } from "../indexer/__tests__/watch-fakes";
import { addr, fakeChain, fakeInspector, fakeNow } from "./fakes";

// Watchdog's step (design 3.4) inside whole runs, against the emulator: first sight, a change and its alert in one
// batch, the fan-out to linked watchers only and its resumption after a crash, the sends and their retries, the kill
// switches, the page cursor, the time limits, the breaker, and what the logs may carry.

const db = arcosDb();
const host = process.env.FIRESTORE_EMULATOR_HOST as string;
const project = (process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT) as string;

afterAll(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

async function reset() {
  const res = await fetch(`http://${host}/emulator/v1/projects/${project}/databases/${DATABASE_ID}/documents`, { method: "DELETE" });
  expect(res.ok).toBe(true);
  instancePause.until = 0;
}
beforeEach(reset);

const HEAD = 1_000_000;
const A = addr(0x8f3a);
const B = addr(0xb2b2);
const PAIR = addr(0x1a1a);
const OWNER_1 = addr(0xabc);
const OWNER_2 = addr(0xdef);
const U1 = addr(0x1001);
const U2 = addr(0x1002);
const U3 = addr(0x1003);
const CHAT_1 = 7_777_777;
const CHAT_3 = 8_888_888;

const clock = fakeNow();
const indexerDoc = async () => (await db.collection(COLLECTIONS.indexer).doc("mainnet").get()).data() as IndexerDoc;
const stateDoc = async (token: string) => (await db.collection(COLLECTIONS.watchState).doc(tokenId("mainnet", token)).get()).data() as WatchStateDoc | undefined;
const userDoc = async (user: string) => (await db.collection(COLLECTIONS.users).doc(user).get()).data() as UserDoc;
const alertsOf = async (token: string) =>
  (await db.collection(COLLECTIONS.alerts).where("token", "==", token).get()).docs.map((d) => ({ id: d.id, ...(d.data() as AlertDoc) }));
const deliveriesAll = async () => (await db.collection(COLLECTIONS.deliveries).get()).docs.map((d) => ({ id: d.id, ...(d.data() as DeliveryDoc) }));
const count = async (collection: string) => (await db.collection(collection).count().get()).data().count;

async function startAt(block: number, over: Partial<IndexerDoc> = {}) {
  await db.collection(COLLECTIONS.indexer).doc("mainnet").set({
    network: "mainnet", block, updatedAt: Timestamp.now(), lastRunAt: null, paused: false, inspect: true, halted: null,
    explorerCalls: { day: "2026-10-01", count: 0 }, runningUntil: null, runId: null, watch: true, telegram: true, watchCursor: null, ...over,
  } satisfies IndexerDoc);
}

async function user(address: Address, chatId: number | null) {
  const doc: UserDoc = {
    address,
    telegram: chatId === null ? null : { chatId, linkedAt: Timestamp.fromMillis(clock.now()) },
    createdAt: Timestamp.fromMillis(clock.now()),
    lastSignInAt: Timestamp.fromMillis(clock.now()),
    sessionVersion: 0,
  };
  await db.collection(COLLECTIONS.users).doc(address).set(doc);
}

async function watch(by: Address, token: Address) {
  expect(await addWatch({ user: by, network: "mainnet", token, now: new Date(clock.now()) }, db)).toEqual({ kind: "added" });
}

/** A's index docs: a DUKE token with a v3 USDC pool as its deepest. */
async function indexed(token: Address, pool: Address) {
  const tokenDoc: TokenDoc = {
    network: "mainnet", address: token, name: "Duke", symbol: "DUKE", decimals: 18, totalSupply: null, source: "v3", creator: null,
    firstBlock: HEAD - 100, firstSeen: Timestamp.fromMillis(clock.now()), bestPool: { id: pool, version: "v3", depthUsdc: "5000000000" },
    report: null, radar: { liquid: true, passing: false }, inspect: { state: "done", priority: 1, attempts: 0, queuedAt: null }, launchpad: null,
  };
  const poolDoc: PoolDoc = { network: "mainnet", poolId: pool, version: "v3", token, quote: "USDC", fee: 3000, createdBlock: HEAD - 100, key: null, depthUsdc: null, sampledAt: null };
  await db.collection(COLLECTIONS.tokens).doc(tokenId("mainnet", token)).set(tokenDoc);
  await db.collection(COLLECTIONS.pools).doc(poolId("mainnet", pool)).set(poolDoc);
}

/** What the chain says of each token, changeable between runs. */
type TokenState = { owner: Address | typeof REVERT; totalSupply: bigint; paused: boolean; symbol: string; decimals: number; pool?: Address; depth?: bigint };
const plain = (over: Partial<TokenState> = {}): TokenState => ({ owner: OWNER_1, totalSupply: 10n ** 24n, paused: false, symbol: "DUKE", decimals: 18, ...over });

function chainOf(states: Record<string, TokenState>) {
  const answer = (c: Call): unknown => {
    if (c.functionName === "balanceOf") {
      const pool = (c.args[0] as string).toLowerCase();
      const state = Object.values(states).find((s) => s.pool?.toLowerCase() === pool);
      return state?.depth ?? REVERT;
    }
    const state = states[c.target.toLowerCase()];
    if (!state) return REVERT;
    switch (c.functionName) {
      case "owner":
        return state.owner;
      case "getOwner":
        return REVERT;
      case "totalSupply":
        return state.totalSupply;
      case "paused":
        return state.paused;
      case "symbol":
        return state.symbol;
      case "decimals":
        return state.decimals;
      default:
        return REVERT;
    }
  };
  return { states, reader: fakeWatchReader({ answer }) };
}

type Send = { chatId: number; text: string };
/** A sender that answers `outcomes` in turn (the last one again and again), recording every send. */
function sender(...outcomes: SendOutcome[]): TelegramSender & { sends: Send[] } {
  const sends: Send[] = [];
  return {
    sends,
    send: async (chatId, text) => {
      sends.push({ chatId, text });
      return outcomes[Math.min(sends.length, outcomes.length) - 1] ?? { kind: "ok" };
    },
  };
}

function recorder(): Logger & { lines: { message: string; data?: object }[] } {
  const lines: { message: string; data?: object }[] = [];
  const record = (message: string, data?: object) => void lines.push({ message, data });
  return { lines, info: record, warn: record, error: record };
}

type Ran = Extract<RunResult, { status: "ran" }>;
type RunOptions = { head: number; reader: ChainReader; telegram?: TelegramSender | null; store?: Firestore; log?: Logger; limits?: RunDeps["limits"]; chain?: ReturnType<typeof fakeChain> };
async function run(options: RunOptions): Promise<Ran> {
  const result = await runIndexer({
    db: options.store ?? db,
    network: "mainnet",
    chain: options.chain ?? fakeChain({ head: options.head }),
    inspectToken: fakeInspector({}),
    settings: { inspectPerTick: 0, explorerDailyBudget: 0 },
    now: clock.now,
    log: options.log,
    limits: options.limits,
    watch: { reader: options.reader, telegram: options.telegram === undefined ? sender() : options.telegram },
  });
  expect(result.status).toBe("ran");
  return result as Ran;
}

/** The database as a process that dies at its `n`th batch commit (1-based): that commit and every later one fail. */
function crashingAt(n: number): Firestore {
  let commits = 0;
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "batch") {
        return () => {
          const batch = target.batch();
          const commit = batch.commit.bind(batch);
          batch.commit = async () => {
            if (++commits >= n) throw new Error("the process died");
            return commit();
          };
          return batch;
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** A watched token on first sight, with U1 (linked) and U2 (unlinked) watching it. */
async function seeded() {
  await startAt(HEAD);
  await user(U1, CHAT_1);
  await user(U2, null);
  await indexed(A, PAIR);
  await watch(U1, A);
  await watch(U2, A);
  const chain = chainOf({ [A]: plain({ pool: PAIR, depth: 5_000_000_000n }) });
  const first = await run({ head: HEAD, reader: chain.reader });
  return { chain, first };
}

describe("the first sight", () => {
  it("records the token's state at the tip and alerts nothing, with the step's defaults on a new indexer doc", async () => {
    await user(U1, CHAT_1);
    await watch(U1, A);
    const chain = chainOf({ [A]: plain() });
    const result = await run({ head: HEAD, reader: chain.reader });
    expect(result.watch).toMatchObject({ checked: 1, unread: 0, failed: 0, alerts: 0, writes: 1, deliveriesCreated: 0, sent: 0, skipped: null, cursor: tokenId("mainnet", A) });
    expect(await stateDoc(A)).toMatchObject({ owner: OWNER_1, totalSupply: (10n ** 24n).toString(), paused: false, implementation: null, bestPool: null, bestPoolDepth: null, checkedBlock: HEAD, watchers: 1 });
    expect(await count(COLLECTIONS.alerts)).toBe(0);
    expect(await indexerDoc()).toMatchObject({ watch: true, telegram: true, watchCursor: tokenId("mainnet", A), explorerCalls: { count: 0 } });
    // Every read was pinned to the tip.
    for (const sent of chain.reader.sent) expect(sent.blockNumber).toBe(BigInt(HEAD));
  });

  it("records nothing while a core read is unread, and tries again next run", async () => {
    await startAt(HEAD);
    await user(U1, CHAT_1);
    await watch(U1, A);
    const broken = fakeWatchReader({ answer: () => REVERT, aggregate: new TypeError("fetch failed") });
    const result = await run({ head: HEAD, reader: broken });
    expect(result.watch).toMatchObject({ checked: 1, unread: 1, writes: 0, alerts: 0 });
    expect((await stateDoc(A))!.checkedBlock).toBe(0);
    const chain = chainOf({ [A]: plain() });
    expect((await run({ head: HEAD, reader: chain.reader })).watch).toMatchObject({ checked: 1, writes: 1 });
    expect((await stateDoc(A))!.checkedBlock).toBe(HEAD);
  });
});

describe("a change", () => {
  it("writes the state and its alerts in one batch, creates deliveries for linked watchers only, and sends them", async () => {
    const { chain } = await seeded();
    expect(await stateDoc(A)).toMatchObject({ bestPool: PAIR, bestPoolDepth: "5000000000", checkedBlock: HEAD });
    chain.states[A] = plain({ owner: OWNER_2, pool: PAIR, depth: 1_000_000_000n });
    const telegram = sender({ kind: "ok" });
    const log = recorder();
    const result = await run({ head: HEAD + 10, reader: chain.reader, telegram, log });
    expect(result.watch).toMatchObject({ checked: 1, alerts: 2, writes: 1, deliveriesCreated: 2, fannedOut: 2, sent: 2, sendFailed: 0 });
    expect(result).toMatchObject({ explorerCalls: 0, error: null });
    expect(await stateDoc(A)).toMatchObject({ owner: OWNER_2, bestPoolDepth: "1000000000", checkedBlock: HEAD + 10 });

    const alerts = await alertsOf(A);
    expect(alerts.map((a) => a.kind).sort()).toEqual(["liquidity_dropped", "owner_changed"]);
    const owner = alerts.find((a) => a.kind === "owner_changed")!;
    expect(owner).toMatchObject({ network: "mainnet", token: A, block: HEAD + 10, fannedOut: true, detail: { symbol: "DUKE", decimals: 18, from: OWNER_1, to: OWNER_2, renounced: false } });
    expect(owner.expiresAt.toMillis() - owner.createdAt.toMillis()).toBe(TTL_MS.alerts);
    const drop = alerts.find((a) => a.kind === "liquidity_dropped")!;
    expect(drop.detail).toMatchObject({ quote: "USDC", pool: PAIR, from: "5000000000", to: "1000000000", pct: 80 });

    const deliveries = await deliveriesAll();
    expect(deliveries.map((d) => d.id).sort()).toEqual(alerts.map((a) => deliveryId(a.id, U1)).sort());
    for (const d of deliveries) {
      expect(d).toMatchObject({ user: U1, channel: "telegram", status: "sent", attempts: 1, error: null });
      expect(d.deliveredAt!.toMillis()).toBe(clock.now());
      expect(d.expiresAt.toMillis() - d.createdAt.toMillis()).toBe(TTL_MS.deliveries);
    }
    expect(telegram.sends).toHaveLength(2);
    expect(telegram.sends.every((s) => s.chatId === CHAT_1)).toBe(true);
    const texts = telegram.sends.map((s) => s.text).sort();
    expect(texts[1]).toBe(`DUKE (0x0000…8f3a): owner changed from 0x0000…0abc to 0x0000…0def at block 1,000,010 — https://explorer.arc.io/token/${A}`);
    expect(texts[0]).toBe(`DUKE (0x0000…8f3a): deepest pool's USDC fell from 5,000 to 1,000 (80% lower) at block 1,000,010 — https://explorer.arc.io/token/${A}`);

    // The run line carries the counters, and no line carries an address, a chat id or a message.
    const logged = JSON.stringify(log.lines);
    expect(logged).not.toMatch(/0x/i);
    expect(logged).not.toContain(String(CHAT_1));
    expect(logged).not.toMatch(/DUKE|owner changed/);
    expect((await indexerDoc()).explorerCalls.count).toBe(0);
  });

  it("alerts nothing for the same state at a later block, and writes nothing", async () => {
    const { chain } = await seeded();
    const before = (await db.collection(COLLECTIONS.watchState).doc(tokenId("mainnet", A)).get()).updateTime!.toMillis();
    const result = await run({ head: HEAD + 10, reader: chain.reader });
    expect(result.watch).toMatchObject({ checked: 1, alerts: 0, writes: 0, deliveriesCreated: 0 });
    expect((await db.collection(COLLECTIONS.watchState).doc(tokenId("mainnet", A)).get()).updateTime!.toMillis()).toBe(before);
  });

  it("alerts nothing again after a crash past the state batch, and resumes the fan-out next run", async () => {
    const { chain } = await seeded();
    chain.states[A] = plain({ owner: OWNER_2, pool: PAIR, depth: 5_000_000_000n });
    const log = recorder();
    // The first batch is the state and its alert; the second, the deliveries, dies.
    const crashed = await run({ head: HEAD + 10, reader: chain.reader, store: crashingAt(2), log });
    expect(crashed).toMatchObject({ error: "Error", watch: null });
    expect(log.lines.find((l) => l.message === "arcosIndexer watch stopped")?.data).toEqual({ error: "Error" });
    expect(await alertsOf(A)).toMatchObject([{ kind: "owner_changed", fannedOut: false }]);
    expect(await count(COLLECTIONS.deliveries)).toBe(0);
    expect((await indexerDoc()).runId).toBeNull();

    const telegram = sender();
    const resumed = await run({ head: HEAD + 20, reader: chain.reader, telegram });
    expect(resumed.watch).toMatchObject({ alerts: 0, writes: 0, deliveriesCreated: 1, fannedOut: 1, sent: 1 });
    expect(await alertsOf(A)).toMatchObject([{ kind: "owner_changed", fannedOut: true }]);
    expect(telegram.sends).toHaveLength(1);
  });

  it("swallows NOT_FOUND when the last watcher left mid-run, and goes on", async () => {
    await startAt(HEAD);
    await user(U1, CHAT_1);
    await watch(U1, A);
    await watch(U1, B);
    const chain = chainOf({ [A]: plain(), [B]: plain() });
    await run({ head: HEAD, reader: chain.reader });
    chain.states[A] = plain({ paused: true });
    chain.states[B] = plain({ paused: true });
    // A's last watcher leaves between the page read and the write: the reader's answer is when it happens.
    const read = chain.reader.read;
    let gone = false;
    chain.reader.read = async (...args) => {
      if (!gone) {
        gone = true;
        expect(await removeWatch({ user: U1, network: "mainnet", token: A }, db)).toEqual({ kind: "removed" });
      }
      return read(...args);
    };
    const log = recorder();
    const result = await run({ head: HEAD + 10, reader: chain.reader, log });
    expect(result).toMatchObject({ error: null });
    expect(result.watch).toMatchObject({ checked: 2, failed: 0, writes: 1, alerts: 1 });
    expect(await stateDoc(A)).toBeUndefined();
    expect(await alertsOf(A)).toEqual([]);
    expect(await alertsOf(B)).toMatchObject([{ kind: "paused" }]);
    expect(log.lines.map((l) => l.message)).not.toContain("arcosIndexer watch stopped");
  });
});

describe("the sends", () => {
  async function alerted(telegram: TelegramSender) {
    const { chain } = await seeded();
    chain.states[A] = plain({ paused: true, pool: PAIR, depth: 5_000_000_000n });
    const result = await run({ head: HEAD + 10, reader: chain.reader, telegram });
    expect(result.watch).toMatchObject({ alerts: 1, deliveriesCreated: 1 });
    return chain;
  }

  it("tries a retryable failure again on later runs, and fails the delivery after 4 attempts", async () => {
    const telegram = sender({ kind: "telegram_5xx", status: 503 });
    const chain = await alerted(telegram);
    for (let attempt = 1; attempt <= DELIVERY_MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) await run({ head: HEAD + 10, reader: chain.reader, telegram });
      const [delivery] = await deliveriesAll();
      expect(delivery, `attempt ${attempt}`).toMatchObject({ attempts: attempt, error: "telegram_5xx", status: attempt < DELIVERY_MAX_ATTEMPTS ? "pending" : "failed" });
      expect(telegram.sends).toHaveLength(attempt);
    }
    await run({ head: HEAD + 10, reader: chain.reader, telegram });
    expect(telegram.sends).toHaveLength(DELIVERY_MAX_ATTEMPTS);
    expect((await userDoc(U1)).telegram).not.toBeNull();
  });

  it("fails the delivery and unlinks the wallet when the chat blocked the bot", async () => {
    const telegram = sender({ kind: "blocked" });
    const chain = await alerted(telegram);
    expect(await deliveriesAll()).toMatchObject([{ status: "failed", attempts: 1, error: "blocked" }]);
    expect((await userDoc(U1)).telegram).toBeNull();
    // Nothing more is sent to it: a later alert finds no linked watcher.
    chain.states[A] = plain({ paused: false, pool: PAIR, depth: 5_000_000_000n });
    const result = await run({ head: HEAD + 20, reader: chain.reader, telegram });
    expect(result.watch).toMatchObject({ alerts: 1, deliveriesCreated: 0, fannedOut: 1 });
    expect(telegram.sends).toHaveLength(1);
  });

  it("pauses sends on this instance after a 429, for the seconds asked, leaving the delivery untouched", async () => {
    const telegram = sender({ kind: "rate_limited", retryAfterSec: 30 }, { kind: "ok" });
    const log = recorder();
    const { chain } = await seeded();
    chain.states[A] = plain({ paused: true, pool: PAIR, depth: 5_000_000_000n });
    const result = await run({ head: HEAD + 10, reader: chain.reader, telegram, log });
    expect(result.watch).toMatchObject({ sent: 0, sendFailed: 0 });
    expect(await deliveriesAll()).toMatchObject([{ status: "pending", attempts: 0, error: null }]);
    expect(log.lines.find((l) => l.message === "arcosIndexer telegram paused")?.data).toEqual({ code: "rate_limited", seconds: 30 });
    clock.advance(29_000);
    await run({ head: HEAD + 10, reader: chain.reader, telegram });
    expect(telegram.sends).toHaveLength(1);
    clock.advance(1_000);
    expect((await run({ head: HEAD + 10, reader: chain.reader, telegram })).watch).toMatchObject({ sent: 1 });
    expect(await deliveriesAll()).toMatchObject([{ status: "sent", attempts: 1 }]);
  });

  it("fails a delivery that waited a day as expired, without sending it", async () => {
    const telegram = sender({ kind: "timeout" }, { kind: "ok" });
    const chain = await alerted(telegram);
    clock.advance(DELIVERY_MAX_AGE_MS);
    const result = await run({ head: HEAD + 10, reader: chain.reader, telegram });
    expect(result.watch).toMatchObject({ sent: 0, sendFailed: 1 });
    expect(await deliveriesAll()).toMatchObject([{ status: "failed", error: "expired", attempts: 1 }]);
    expect(telegram.sends).toHaveLength(1);
  });

  it("sends each chat's deliveries in order and never more than 3 per chat a run", async () => {
    await startAt(HEAD);
    await user(U1, CHAT_1);
    await user(U3, CHAT_3);
    const tokens = [A, B, addr(0xc3c3), addr(0xd4d4)];
    for (const token of tokens.slice(0, 3)) await watch(U1, token);
    await watch(U3, tokens[3]!);
    await watch(U3, A);
    const states = Object.fromEntries(tokens.map((t) => [t, plain()]));
    const chain = chainOf(states);
    await run({ head: HEAD, reader: chain.reader });
    for (const token of tokens) chain.states[token] = plain({ paused: true });
    const telegram = sender();
    const result = await run({ head: HEAD + 10, reader: chain.reader, telegram });
    expect(result.watch).toMatchObject({ alerts: 4, deliveriesCreated: 5, sent: 5 });
    const chat1 = telegram.sends.filter((s) => s.chatId === CHAT_1);
    const chat3 = telegram.sends.filter((s) => s.chatId === CHAT_3);
    expect([chat1.length, chat3.length]).toEqual([3, 2]);
    expect(WATCH.perChatPerRun).toBe(3);
  });
});

describe("the switches", () => {
  it("does nothing at all with watch false, and skips the sends alone with telegram false", async () => {
    const { chain } = await seeded();
    chain.states[A] = plain({ paused: true, pool: PAIR, depth: 5_000_000_000n });
    await db.collection(COLLECTIONS.indexer).doc("mainnet").update({ watch: false });
    const telegram = sender();
    const off = await run({ head: HEAD + 10, reader: chain.reader, telegram });
    expect(off.watch).toMatchObject({ skipped: "off", checked: 0, alerts: 0 });
    expect(chain.reader.sent).toHaveLength(3); // the first sight's reads only
    expect(await count(COLLECTIONS.alerts)).toBe(0);

    await db.collection(COLLECTIONS.indexer).doc("mainnet").update({ watch: true, telegram: false });
    const quiet = await run({ head: HEAD + 10, reader: chain.reader, telegram });
    expect(quiet.watch).toMatchObject({ skipped: null, alerts: 1, deliveriesCreated: 1, sent: 0 });
    expect(telegram.sends).toEqual([]);
    expect(await deliveriesAll()).toMatchObject([{ status: "pending", attempts: 0 }]);

    // Missing fields read as true.
    await db.collection(COLLECTIONS.indexer).doc("mainnet").update({ watch: FieldValue.delete(), telegram: FieldValue.delete() });
    const on = await run({ head: HEAD + 10, reader: chain.reader, telegram });
    expect(on.watch).toMatchObject({ skipped: null, sent: 1 });
  });

  it("skips the step without Watchdog deps, and without a sender runs the checks and keeps the deliveries pending", async () => {
    const { chain } = await seeded();
    chain.states[A] = plain({ paused: true, pool: PAIR, depth: 5_000_000_000n });
    const none = await runIndexer({ db, network: "mainnet", chain: fakeChain({ head: HEAD + 10 }), inspectToken: fakeInspector({}), settings: { inspectPerTick: 0, explorerDailyBudget: 0 }, now: clock.now });
    expect(none).toMatchObject({ status: "ran", watch: null });
    expect(chain.reader.sent).toHaveLength(3);
    const quiet = await run({ head: HEAD + 10, reader: chain.reader, telegram: null });
    expect(quiet.watch).toMatchObject({ alerts: 1, deliveriesCreated: 1, sent: 0 });
    expect(await deliveriesAll()).toMatchObject([{ status: "pending" }]);
  });
});

describe("the page", () => {
  it("checks 40 tokens a run in doc id order, wraps, and keeps the cursor in the indexer doc", async () => {
    await startAt(HEAD);
    const tokens = Array.from({ length: 45 }, (_, i) => addr(0x2000 + i));
    const ids = tokens.map((t) => tokenId("mainnet", t)).sort();
    for (const token of tokens) {
      const doc: WatchStateDoc = { network: "mainnet", token, owner: null, totalSupply: null, paused: null, implementation: null, bestPool: null, bestPoolDepth: null, checkedBlock: 0, watchers: 1, lastCheckedAt: Timestamp.fromMillis(0) };
      await db.collection(COLLECTIONS.watchState).doc(tokenId("mainnet", token)).set(doc);
    }
    const chain = chainOf(Object.fromEntries(tokens.map((t) => [t, plain()])));
    const first = await run({ head: HEAD, reader: chain.reader });
    expect(first.watch).toMatchObject({ checked: 40, writes: 40, cursor: ids[39] });
    expect((await indexerDoc()).watchCursor).toBe(ids[39]);
    expect(WATCH.tokensPerRun).toBe(40);

    // Every token pauses: the next page's 40 are written at the new tip, the 35 seen before each with an alert.
    for (const token of tokens) chain.states[token] = plain({ paused: true });
    const second = await run({ head: HEAD + 10, reader: chain.reader });
    expect(second.watch).toMatchObject({ checked: 40, writes: 40, alerts: 35, cursor: ids[34] });
    expect((await indexerDoc()).watchCursor).toBe(ids[34]);
    const blocks = await Promise.all(ids.map(async (id) => ((await db.collection(COLLECTIONS.watchState).doc(id).get()).data() as WatchStateDoc).checkedBlock));
    // The last 5 and the first 35 were checked at the new tip; 36 to 40 wait for their turn.
    expect(blocks.slice(0, 35).every((b) => b === HEAD + 10)).toBe(true);
    expect(blocks.slice(35, 40).every((b) => b === HEAD)).toBe(true);
    expect(blocks.slice(40).every((b) => b === HEAD + 10)).toBe(true);
    expect(chain.reader.sent.filter((s) => s.kind === "aggregate")).toHaveLength(80);
  });

  it("starts no read once the clock is past the reads limit, and skips the step once it is past the start limit", async () => {
    await startAt(HEAD - 1);
    await user(U1, CHAT_1);
    await watch(U1, A);
    const chain = chainOf({ [A]: plain() });
    const slow = fakeChain({ head: HEAD });
    const logs = slow.logs;
    slow.logs = async (filter) => {
      clock.advance(63_000);
      return logs(filter);
    };
    const late = await run({ head: HEAD, reader: chain.reader, chain: slow, limits: { watchStartUntilMs: 70_000 } });
    expect(late.watch).toMatchObject({ skipped: null, checked: 0, cursor: null });
    expect(chain.reader.sent).toEqual([]);
    expect((await stateDoc(A))!.checkedBlock).toBe(0);

    await db.collection(COLLECTIONS.indexer).doc("mainnet").update({ block: HEAD - 1 });
    const skipped = await run({ head: HEAD, reader: chain.reader, chain: slow });
    expect(skipped.watch).toMatchObject({ skipped: "late", checked: 0 });
    expect(chain.reader.sent).toEqual([]);
    expect(LIMITS).toMatchObject({ watchStartUntilMs: 55_000, watchReadsUntilMs: 62_000, watchFanoutUntilMs: 68_000, watchSendUntilMs: 72_000 });
  });

  it("stops the run's reads after 3 consecutive transport failures, and goes on next run", async () => {
    await startAt(HEAD);
    await user(U1, CHAT_1);
    await user(U3, CHAT_3);
    const tokens = Array.from({ length: 6 }, (_, i) => addr(0x3000 + i));
    for (const [i, token] of tokens.entries()) await watch(i < 3 ? U1 : U3, token);
    const down = fakeWatchReader({ answer: () => REVERT, aggregate: new TypeError("fetch failed") });
    const log = recorder();
    const result = await run({ head: HEAD, reader: down, log });
    expect(result.watch).toMatchObject({ checked: WATCH.readConcurrency, unread: WATCH.readConcurrency, writes: 0 });
    expect(log.lines.find((l) => l.message === "arcosIndexer watch reads stopped")?.data).toEqual({ code: "breaker" });
    expect(log.lines.filter((l) => l.message === "arcosIndexer watch read failed")).toHaveLength(WATCH.readConcurrency);
    expect(WATCH.breaker).toBe(3);
    const ids = tokens.map((t) => tokenId("mainnet", t)).sort();
    expect((await indexerDoc()).watchCursor).toBe(ids[WATCH.readConcurrency - 1]);

    const chain = chainOf(Object.fromEntries(tokens.map((t) => [t, plain()])));
    const next = await run({ head: HEAD + 10, reader: chain.reader });
    expect(next.watch).toMatchObject({ checked: 6, writes: 6, cursor: ids[3] });
  });

  it("caps the 'read failed' lines at 5 a run, then says the rest were suppressed", async () => {
    await startAt(HEAD);
    await user(U1, CHAT_1);
    await user(U3, CHAT_3);
    const tokens = Array.from({ length: 6 }, (_, i) => addr(0x4000 + i));
    for (const [i, token] of tokens.entries()) await watch(i < 3 ? U1 : U3, token);
    // Reverting aggregates don't trip the breaker, so every token is read, and every read is logged.
    const reverting = fakeWatchReader({ answer: () => REVERT, aggregate: new CallReverted() });
    const log = recorder();
    const result = await run({ head: HEAD, reader: reverting, log });
    expect(result.watch).toMatchObject({ checked: 6, unread: 6 });
    const failed = log.lines.filter((l) => l.message === "arcosIndexer watch read failed");
    expect(failed).toHaveLength(WATCH.logCap + 1);
    expect(failed.slice(0, WATCH.logCap).every((l) => JSON.stringify(l.data) === JSON.stringify({ code: "reverted" }))).toBe(true);
    expect(failed.at(-1)!.data).toEqual({ suppressed: true });
  });
});
