import { deleteApp, getApps } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { COLLECTIONS, DATABASE_ID, statsDaysId, statsId, type IndexerDoc, type StatsDaysDoc, type StatsDoc } from "@arcos/data";
import { arcosDb } from "@arcos/data/server";
import { decodeStatsLogs, statsSources } from "../indexer/stats";
import { runIndexer, runLogFields, type RunResult } from "../indexer/run";
import { SERVER_COUNT_EVERY_MS, applyStatsWindow, ensureStats, writeServerCounts } from "../indexer/stats-store";
import { USDC, addr, drop, feeChanged, seedFees, tokenCreated, HOUSE, OLD_MULTISEND, NEW_MULTISEND, timeOf } from "../indexer/__tests__/stats-logs";
import type { RawLog } from "../indexer/events";
import { fakeChain, fakeInspector, fakeNow } from "./fakes";

const db = arcosDb();
const host = process.env.FIRESTORE_EMULATOR_HOST as string;
const project = (process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT) as string;

afterAll(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

/** Empties the arcos database (the emulator's own reset endpoint; it never runs against a live project). */
async function reset() {
  const res = await fetch(`http://${host}/emulator/v1/projects/${project}/databases/${DATABASE_ID}/documents`, { method: "DELETE" });
  expect(res.ok).toBe(true);
}
beforeEach(reset);

const FROM = { block: 1_000, at: "2026-09-25" };
const sources = statsSources("mainnet");
const stats = async () => (await db.collection(COLLECTIONS.stats).doc(statsId("mainnet")).get()).data() as StatsDoc | undefined;
const days = async (month: string) => (await db.collection(COLLECTIONS.statsDays).doc(statsDaysId("mainnet", month)).get()).data() as StatsDaysDoc | undefined;
const NOW = Date.parse("2026-11-08T12:00:00Z");

describe("applyStatsWindow", () => {
  it("creates the stats doc one block before the start, so the start block's logs are counted", async () => {
    const doc = await ensureStats(db, "mainnet", FROM, NOW);
    expect(doc).toMatchObject({ network: "mainnet", block: 999, fromBlock: 1_000, head: 999, server: null, excluded: { tokensCreated: 0, drops: 0 } });
    expect(doc.onchainSince.toDate().toISOString()).toBe("2026-09-25T00:00:00.000Z");
    expect(doc.totals).toMatchObject({ tokensCreated: 0, drops: 0, feesMint: "0", feesDrop: "0" });
    // A second call finds it and changes nothing.
    await ensureStats(db, "mainnet", { block: 5, at: "2020-01-01" }, NOW + 1);
    expect((await stats())?.fromBlock).toBe(1_000);
  });

  it("folds a window into the totals and the cursor in one write, with the day buckets", async () => {
    await ensureStats(db, "mainnet", FROM, NOW);
    const logs = [...seedFees(1_000), tokenCreated({ block: 1_010 }, { mintable: true }), drop({ block: 1_020 }, { recipients: 300, failed: 10 })];
    const result = await applyStatsWindow(db, "mainnet", { from: 1_000, to: 1_999 }, logs, { sources, tip: 2_500, now: NOW });
    expect(result).toEqual({ kind: "applied", block: 1_999, delta: { tokensCreated: 1, drops: 1 } });
    const doc = await stats();
    expect(doc).toMatchObject({ block: 1_999, head: 2_500, fees: { mintFlat: String(USDC), dropPerRecipient: String(USDC / 100n), dropMin: String(2n * USDC) } });
    expect(doc?.totals).toMatchObject({
      tokensCreated: 1,
      byTemplate: { standard: 0, mintable: 1, burnable: 0, mintableBurnable: 0 },
      drops: 1,
      dropsNative: 1,
      rowsSubmitted: 300,
      rowsDelivered: 290,
      rowsFailed: 10,
      feesMint: String(USDC),
      feesDrop: String(3n * USDC),
    });
    expect(doc?.updatedAt.toMillis()).toBe(NOW);
    const month = timeOf(1_010);
    expect(new Date(month * 1000).toISOString().slice(0, 7)).toBe("2026-11");
    expect((await days("2026-11"))?.days).toEqual({ "2026-11-01": { tokensCreated: 1, drops: 1, rowsDelivered: 290 } });
  });

  it("counts a window applied twice once, and writes nothing the second time", async () => {
    await ensureStats(db, "mainnet", FROM, NOW);
    const logs = [tokenCreated({ block: 1_010 }), drop({ block: 1_011 }, { recipients: 4 })];
    const window = { from: 1_000, to: 1_999 };
    expect((await applyStatsWindow(db, "mainnet", window, logs, { sources, tip: 2_000, now: NOW })).kind).toBe("applied");
    const after = await stats();
    const again = await applyStatsWindow(db, "mainnet", window, logs, { sources, tip: 2_000, now: NOW + 60_000 });
    expect(again).toEqual({ kind: "already", block: 1_999 });
    const second = await stats();
    expect(second?.totals).toEqual(after?.totals);
    expect(second?.updatedAt.toMillis()).toBe(NOW);
    expect((await days("2026-11"))?.days["2026-11-01"]).toEqual({ tokensCreated: 1, drops: 1, rowsDelivered: 4 });
  });

  it("counts a window once when two runs apply it at the same moment", async () => {
    await ensureStats(db, "mainnet", FROM, NOW);
    const logs = [tokenCreated({ block: 1_010 }), tokenCreated({ block: 1_011 })];
    const window = { from: 1_000, to: 1_999 };
    const results = await Promise.all([1, 2, 3].map((i) => applyStatsWindow(db, "mainnet", window, logs, { sources, tip: 2_000, now: NOW + i })));
    expect(results.filter((r) => r.kind === "applied")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "already" || r.kind === "moved")).toHaveLength(2);
    expect((await stats())?.totals.tokensCreated).toBe(2);
    expect((await days("2026-11"))?.days["2026-11-01"]?.tokensCreated).toBe(2);
  });

  it("writes nothing for a window that doesn't start at the cursor: another run moved it", async () => {
    await ensureStats(db, "mainnet", FROM, NOW);
    await applyStatsWindow(db, "mainnet", { from: 1_000, to: 1_999 }, [tokenCreated({ block: 1_500 })], { sources, tip: 3_000, now: NOW });
    const before = await stats();
    // A run that read [3,000..3,999] while the cursor is at 1,999: a gap, so it must not be applied.
    const gap = await applyStatsWindow(db, "mainnet", { from: 3_000, to: 3_999 }, [tokenCreated({ block: 3_100 })], { sources, tip: 4_000, now: NOW + 5 });
    expect(gap).toEqual({ kind: "moved", block: 1_999 });
    // A run that read [1,500..2,499], which overlaps the part already folded.
    const overlap = await applyStatsWindow(db, "mainnet", { from: 1_500, to: 2_499 }, [tokenCreated({ block: 1_600 })], { sources, tip: 4_000, now: NOW + 6 });
    expect(overlap).toEqual({ kind: "moved", block: 1_999 });
    expect(await stats()).toEqual(before);
  });

  it("moves the cursor forward only: an earlier window after a later one changes nothing", async () => {
    await ensureStats(db, "mainnet", FROM, NOW);
    await applyStatsWindow(db, "mainnet", { from: 1_000, to: 1_999 }, [], { sources, tip: 3_000, now: NOW });
    await applyStatsWindow(db, "mainnet", { from: 2_000, to: 2_999 }, [tokenCreated({ block: 2_500 })], { sources, tip: 3_000, now: NOW + 1 });
    const result = await applyStatsWindow(db, "mainnet", { from: 1_000, to: 1_999 }, [tokenCreated({ block: 1_500 })], { sources, tip: 3_000, now: NOW + 2 });
    expect(result).toEqual({ kind: "already", block: 2_999 });
    const doc = await stats();
    expect([doc?.block, doc?.totals.tokensCreated]).toEqual([2_999, 1]);
    // And the head only grows.
    await applyStatsWindow(db, "mainnet", { from: 3_000, to: 3_000 }, [], { sources, tip: 2_000, now: NOW + 3 });
    expect((await stats())?.head).toBe(3_000);
  });

  it("answers 'missing' without a stats doc, and writes none", async () => {
    expect(await applyStatsWindow(db, "mainnet", { from: 1_000, to: 1_999 }, [], { sources, tip: 2_000, now: NOW })).toEqual({ kind: "missing" });
    expect(await stats()).toBeUndefined();
  });

  it("adds to a day's counts across windows, and splits a window that crosses a month into two docs", async () => {
    await ensureStats(db, "mainnet", FROM, NOW);
    // Block times: the 31st of October, 23:59:59 and the 1st of November, 00:00:00.
    const at = (block: number, t: number) => ({ block, timestamp: t });
    const oct31 = Date.parse("2026-10-31T23:59:59Z") / 1000;
    const logs = [
      tokenCreated(at(1_100, oct31)),
      tokenCreated(at(1_101, oct31 + 1)),
      drop(at(1_102, oct31 + 1), { recipients: 5, failed: 1 }),
    ];
    await applyStatsWindow(db, "mainnet", { from: 1_000, to: 1_999 }, logs, { sources, tip: 3_000, now: NOW });
    await applyStatsWindow(db, "mainnet", { from: 2_000, to: 2_999 }, [tokenCreated(at(2_100, oct31 + 100)), drop(at(2_101, oct31 + 100), { recipients: 2 })], { sources, tip: 3_000, now: NOW + 1 });
    expect((await days("2026-10"))?.days).toEqual({ "2026-10-31": { tokensCreated: 1, drops: 0, rowsDelivered: 0 } });
    expect((await days("2026-11"))?.days).toEqual({ "2026-11-01": { tokensCreated: 2, drops: 2, rowsDelivered: 6 } });
    expect(await days("2026-10")).toMatchObject({ network: "mainnet", month: "2026-10" });
  });
});

describe("writeServerCounts", () => {
  const seed = async () => {
    const at = (iso: string) => Timestamp.fromMillis(Date.parse(iso));
    const users = db.collection(COLLECTIONS.users);
    await users.doc("0x01").set({ address: "0x01", telegram: null, createdAt: at("2026-10-14T08:00:00Z") });
    await users.doc("0x02").set({ address: "0x02", telegram: { chatId: 1, linkedAt: at("2026-10-15T08:00:00Z") }, createdAt: at("2026-10-16T08:00:00Z") });
    await users.doc("0x03").set({ address: "0x03", telegram: { chatId: 2, linkedAt: at("2026-10-17T08:00:00Z") }, createdAt: at("2026-10-18T08:00:00Z") });
    const watches = db.collection(COLLECTIONS.watches);
    await watches.doc("a").set({ user: "0x01", network: "mainnet", token: "0xaa", createdAt: at("2026-10-20T08:00:00Z") });
    await watches.doc("b").set({ user: "0x02", network: "mainnet", token: "0xaa", createdAt: at("2026-10-21T08:00:00Z") });
    await watches.doc("c").set({ user: "0x02", network: "testnet", token: "0xbb", createdAt: at("2026-10-19T08:00:00Z") });
    const state = db.collection(COLLECTIONS.watchState);
    await state.doc("mainnet:0xaa").set({ network: "mainnet", watchers: 2 });
    await state.doc("testnet:0xbb").set({ network: "testnet", watchers: 1 });
    const tokens = db.collection(COLLECTIONS.tokens);
    const token = (n: number, network: string, state: string, iso: string) =>
      tokens.doc(`${network}:0x${n}`).set({ network, inspect: { state, priority: 0, attempts: 0, queuedAt: null }, firstSeen: at(iso) });
    await token(1, "mainnet", "done", "2026-10-01T00:30:00Z");
    await token(2, "mainnet", "queued", "2026-10-02T00:30:00Z");
    await token(3, "mainnet", "done", "2026-10-03T00:30:00Z");
    await token(4, "mainnet", "skipped", "2026-10-04T00:30:00Z");
    await token(5, "testnet", "done", "2026-09-30T00:30:00Z");
  };

  it("counts users, linked chats, mainnet watches and watched tokens, indexed and inspected tokens, with the oldest dates", async () => {
    await seed();
    await ensureStats(db, "mainnet", FROM, NOW);
    await writeServerCounts(db, "mainnet", NOW + 5);
    const server = (await stats())?.server;
    expect(server).toMatchObject({ users: 3, telegramLinked: 2, watches: 2, watchedTokens: 1, tokensIndexed: 4, tokensInspected: 2 });
    expect(server?.countedAt.toMillis()).toBe(NOW + 5);
    expect(server?.since.users?.toDate().toISOString()).toBe("2026-10-14T08:00:00.000Z");
    expect(server?.since.watches?.toDate().toISOString()).toBe("2026-10-19T08:00:00.000Z");
    expect(server?.since.tokens?.toDate().toISOString()).toBe("2026-09-30T00:30:00.000Z");
  });

  it("counts empty collections as 0 with no dates", async () => {
    await ensureStats(db, "mainnet", FROM, NOW);
    await writeServerCounts(db, "mainnet", NOW);
    expect((await stats())?.server).toMatchObject({ users: 0, telegramLinked: 0, watches: 0, watchedTokens: 0, tokensIndexed: 0, tokensInspected: 0, since: { users: null, watches: null, tokens: null } });
  });

  it("stores no address anywhere in the stats doc", async () => {
    await seed();
    await ensureStats(db, "mainnet", FROM, NOW);
    await writeServerCounts(db, "mainnet", NOW);
    expect(JSON.stringify(await stats())).not.toMatch(/0x[0-9a-fA-F]{8}/);
  });
});

describe("the Stats step of a run", () => {
  const clock = fakeNow(NOW);
  const START = 5_000_000;
  const stateAt = async (block: number, over: Partial<IndexerDoc> = {}) => {
    await db.collection(COLLECTIONS.indexer).doc("mainnet").set({
      network: "mainnet", block, updatedAt: Timestamp.now(), lastRunAt: null, paused: false, inspect: true, halted: null,
      explorerCalls: { day: "2026-11-08", count: 0 }, runningUntil: null, runId: null, ...over,
    } satisfies IndexerDoc);
  };
  type Ran = Extract<RunResult, { status: "ran" }>;
  const go = async (
    chain: ReturnType<typeof fakeChain>,
    stats: Record<string, unknown> | null = { from: { block: START, at: "2026-09-25" } },
    log?: { info(m: string, d?: object): void; warn(m: string, d?: object): void; error(m: string, d?: object): void },
  ) =>
    (await runIndexer({
      db, network: "mainnet", chain, inspectToken: fakeInspector({}), settings: { inspectPerTick: 0, explorerDailyBudget: 0 }, now: clock.now, log,
      ...(stats ? { stats } : {}),
    })) as Ran;
  /** The stats step's windows only: the main window loop has nothing to read when its cursor is at the head. */
  const HEAD = START + 25_000;

  it("starts at the FeeController's block, folds each window once, and reports counts only", async () => {
    await stateAt(HEAD);
    const logs = [
      ...seedFees(START),
      tokenCreated({ block: START + 5 }),
      tokenCreated({ block: START + 12_000 }, { mintable: true, burnable: true }),
      drop({ block: START + 12_001 }, { recipients: 8, failed: 3, address: OLD_MULTISEND }),
      drop({ block: START + 24_000 }, { recipients: 2, token: addr(0xabc), address: NEW_MULTISEND }),
    ];
    const chain = fakeChain({ head: HEAD, logs });
    const result = await go(chain);
    expect(result.stats).toEqual({ windows: 3, tokensCreated: 2, drops: 2, behind: 0, error: null });
    expect(chain.asked).toEqual([
      { from: START, to: START + 9_999 },
      { from: START + 10_000, to: START + 19_999 },
      { from: START + 20_000, to: START + 25_000 },
    ]);
    const doc = await stats();
    expect(doc).toMatchObject({ block: HEAD, fromBlock: START, head: HEAD });
    expect(doc?.totals).toMatchObject({ tokensCreated: 2, drops: 2, dropsNative: 1, dropsToken: 1, rowsSubmitted: 10, rowsDelivered: 7, rowsFailed: 3 });
    expect(doc?.server).not.toBeNull();
    // The next run has nothing new to read, and counts nothing again.
    const again = await go(fakeChain({ head: HEAD, logs }));
    expect(again.stats).toEqual({ windows: 0, tokensCreated: 0, drops: 0, behind: 0, error: null });
    expect((await stats())?.totals.tokensCreated).toBe(2);
  });

  it("counts a log in the start block, and leaves the project wallet out of the totals", async () => {
    await stateAt(HEAD);
    const logs = [
      tokenCreated({ block: START }),
      tokenCreated({ block: START + 1 }, { creator: HOUSE }),
      drop({ block: START + 2 }, { sender: HOUSE, recipients: 100 }),
      drop({ block: START + 3 }, { recipients: 3 }),
    ];
    const result = await go(fakeChain({ head: HEAD, logs }));
    expect(result.stats).toMatchObject({ tokensCreated: 1, drops: 1 });
    const doc = await stats();
    expect(doc?.totals).toMatchObject({ tokensCreated: 1, drops: 1, rowsSubmitted: 3 });
    expect(doc?.excluded).toEqual({ tokensCreated: 1, drops: 1 });
  });

  it("stops at the window cap, says how far behind it is, and the next run carries on without counting anything twice", async () => {
    await stateAt(HEAD);
    const logs = [tokenCreated({ block: START + 100 }), tokenCreated({ block: START + 10_100 }), tokenCreated({ block: START + 20_100 })];
    const first = await go(fakeChain({ head: HEAD, logs }), { from: { block: START, at: "2026-09-25" }, limits: { maxWindows: 2 } });
    expect(first.stats).toEqual({ windows: 2, tokensCreated: 2, drops: 0, behind: 5_001, error: null });
    expect((await stats())?.block).toBe(START + 19_999);
    const second = await go(fakeChain({ head: HEAD, logs }), { from: { block: START, at: "2026-09-25" }, limits: { maxWindows: 2 } });
    expect(second.stats).toEqual({ windows: 1, tokensCreated: 1, drops: 0, behind: 0, error: null });
    expect((await stats())?.totals.tokensCreated).toBe(3);
  });

  it("starts no window after its time limit", async () => {
    await stateAt(HEAD);
    const real = fakeChain({ head: HEAD, logs: [] });
    const slow = { ...real, logs: async (f: Parameters<typeof real.logs>[0]) => { clock.advance(30_000); return real.logs(f); } };
    const result = await go(slow as unknown as ReturnType<typeof fakeChain>, { from: { block: START, at: "2026-09-25" }, limits: { untilMs: 50_000 } });
    // Windows begin at 0 s and 30 s of the step; the one that would begin at 60 s doesn't.
    expect(result.stats?.windows).toBe(2);
    expect(real.asked).toHaveLength(2);
    expect(result.stats?.behind).toBe(5_001);
  });

  it("reads nothing, and writes no stats doc, when the console switch is off", async () => {
    await stateAt(HEAD, { stats: false });
    const chain = fakeChain({ head: HEAD, logs: [tokenCreated({ block: START + 1 })] });
    const result = await go(chain);
    expect(result.stats).toBeNull();
    expect(chain.asked).toEqual([]);
    expect(await stats()).toBeUndefined();
  });

  it("is skipped when the run is given no Stats settings", async () => {
    await stateAt(HEAD);
    const chain = fakeChain({ head: HEAD });
    const result = await go(chain, null);
    expect(result.stats).toBeNull();
    expect(chain.asked).toEqual([]);
    expect(await stats()).toBeUndefined();
  });

  it("runs when the switch is true or missing", async () => {
    await stateAt(HEAD, { stats: true });
    expect((await go(fakeChain({ head: HEAD }))).stats).not.toBeNull();
  });

  it("keeps its own cursor: the indexer's is untouched, and a stalled Stats step doesn't hold it back", async () => {
    await stateAt(HEAD - 3);
    const result = await go(fakeChain({ head: HEAD, logs: [] }));
    expect(result.to).toBe(HEAD);
    expect((await db.collection(COLLECTIONS.indexer).doc("mainnet").get()).data()?.block).toBe(HEAD);
    expect((await stats())?.block).toBe(HEAD);
  });

  it("halves a window the node refuses and still counts every log once", async () => {
    await stateAt(HEAD);
    const logs = [tokenCreated({ block: START + 1_000 }), tokenCreated({ block: START + 3_000 }), tokenCreated({ block: START + 6_000 })];
    const chain = fakeChain({ head: START + 7_999, logs, maxSpan: 2_500 });
    const result = await go(chain);
    expect(result.stats).toMatchObject({ tokensCreated: 3, behind: 0, error: null });
    expect(chain.asked.some((w) => w.to - w.from + 1 > 2_500)).toBe(true);
  });

  it("names a window that failed and carries on from the same block next run, counting once", async () => {
    await stateAt(HEAD);
    const logs = [tokenCreated({ block: START + 100 }), tokenCreated({ block: START + 10_100 })];
    const first = await go(fakeChain({ head: HEAD, logs, failCall: 2 }));
    expect(first.stats).toMatchObject({ windows: 1, tokensCreated: 1, error: "Error" });
    expect(first.error).toBe("Error");
    expect((await stats())?.block).toBe(START + 9_999);
    const second = await go(fakeChain({ head: HEAD, logs }));
    expect(second.stats).toMatchObject({ windows: 2, tokensCreated: 1, error: null });
    expect((await stats())?.totals.tokensCreated).toBe(2);
  });

  it("takes the server counts every 10 minutes, not on every run", async () => {
    await stateAt(HEAD);
    await db.collection(COLLECTIONS.users).doc("0x01").set({ address: "0x01", telegram: null, createdAt: Timestamp.fromMillis(NOW - 86_400_000) });
    await go(fakeChain({ head: HEAD }));
    const first = (await stats())?.server;
    expect(first?.users).toBe(1);
    await db.collection(COLLECTIONS.users).doc("0x02").set({ address: "0x02", telegram: null, createdAt: Timestamp.fromMillis(NOW) });

    clock.advance(SERVER_COUNT_EVERY_MS - 1_000);
    await go(fakeChain({ head: HEAD }));
    expect((await stats())?.server?.users).toBe(1);
    expect((await stats())?.server?.countedAt.toMillis()).toBe(first?.countedAt.toMillis());

    clock.advance(1_000);
    await go(fakeChain({ head: HEAD }));
    expect((await stats())?.server?.users).toBe(2);
  });

  it("keeps counting windows when the server counts fail, and names the failure", async () => {
    await stateAt(HEAD);
    const failing = new Proxy(db, {
      get(target, prop) {
        if (prop === "collection") {
          return (name: string) => {
            if (name === COLLECTIONS.users) throw Object.assign(new Error("unavailable"), { name: "Unavailable" });
            return target.collection(name);
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const result = (await runIndexer({
      db: failing, network: "mainnet", chain: fakeChain({ head: HEAD, logs: [tokenCreated({ block: START + 5 })] }), inspectToken: fakeInspector({}),
      settings: { inspectPerTick: 0, explorerDailyBudget: 0 }, now: clock.now, stats: { from: { block: START, at: "2026-09-25" } },
    })) as Ran;
    expect(result.stats).toMatchObject({ tokensCreated: 1, error: "Unavailable" });
    expect(result.error).toBe("Unavailable");
    expect((await stats())?.server).toBeNull();
  });

  it("puts counts and a name in the run line and in its own log lines, and never an address", async () => {
    await stateAt(HEAD);
    const lines: string[] = [];
    const log = { info: (m: string, d?: object) => lines.push(JSON.stringify([m, d])), warn: (m: string, d?: object) => lines.push(JSON.stringify([m, d])), error: (m: string, d?: object) => lines.push(JSON.stringify([m, d])) };
    const logs: RawLog[] = [...seedFees(START), tokenCreated({ block: START + 5 }, { creator: HOUSE }), drop({ block: START + 6 }, { sender: HOUSE })];
    const first = await go(fakeChain({ head: HEAD, logs }), { from: { block: START, at: "2026-09-25" } }, log);
    const second = await go(fakeChain({ head: HEAD, logs, failCall: 1 }), { from: { block: START, at: "2026-09-25" } }, log);
    for (const result of [first, second]) expect(JSON.stringify(runLogFields(result))).not.toMatch(/0x[0-9a-fA-F]{6}/);
    expect(JSON.stringify(runLogFields(first).stats)).toBe(JSON.stringify({ windows: 3, tokensCreated: 0, drops: 0, behind: 0, error: null }));
    expect(lines.join("\n")).not.toMatch(/0x[0-9a-fA-F]{6}/);
    expect(JSON.stringify(await stats())).not.toContain(HOUSE.toLowerCase().slice(2, 12));
  });

  it("applies the same logs the unit fold reads: the totals in the doc equal a fold of every window", async () => {
    await stateAt(HEAD);
    const logs = [
      ...seedFees(START),
      feeChanged({ block: START + 9_999, logIndex: 1 }, "MINT_FLAT", USDC / 4n),
      tokenCreated({ block: START + 9_999, logIndex: 2 }),
      tokenCreated({ block: START + 10_000, logIndex: 0 }),
      drop({ block: START + 15_000 }, { recipients: 1_000 }),
    ];
    await go(fakeChain({ head: HEAD, logs }));
    const doc = await stats();
    const events = decodeStatsLogs(logs, sources, { from: START, to: HEAD });
    expect(events).toHaveLength(logs.length);
    // Mint at 0.25 for both (the change at log index 1 of block START+9,999 comes before them), and a 1,000-row Drop at 0.01 each.
    expect(doc?.totals.feesMint).toBe(String(USDC / 2n));
    expect(doc?.totals.feesDrop).toBe(String(10n * USDC));
    expect(doc?.fees.mintFlat).toBe(String(USDC / 4n));
  });
});
