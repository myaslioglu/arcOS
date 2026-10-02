import { deleteApp, getApps } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { EURC } from "@arcos/chain";
import {
  COLLECTIONS,
  DATABASE_ID,
  INSPECT_PRIORITY,
  INSPECT_QUEUE_MAX_AGE_MS,
  TTL_MS,
  poolId,
  radarFeedId,
  tokenId,
  type IndexerDoc,
  type PoolDoc,
  type RadarFeedDoc,
  type ReportDoc,
  type TokenDoc,
} from "@arcos/data";
import { arcosDb } from "@arcos/data/server";
import type { Pool } from "@arcos/inspector";
import { runIndexer, type InspectToken, type RunResult } from "../indexer/run";
import { BACKFILL_BLOCKS } from "../indexer/windows";
import { USDC_LOWER, ZERO, addr, created, fakeChain, fakeInspector, fakeNow, fakeReport, timeOf, v3Pool, v4Pool, type FakeChainOptions } from "./fakes";

const db = arcosDb();
const host = process.env.FIRESTORE_EMULATOR_HOST as string;
const project = (process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT) as string;

afterAll(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

// Every test starts from an empty arcos database (the emulator's own reset endpoint; it never runs against a live project).
beforeEach(async () => {
  const res = await fetch(`http://${host}/emulator/v1/projects/${project}/databases/${DATABASE_ID}/documents`, { method: "DELETE" });
  expect(res.ok).toBe(true);
});

const HEAD = 1_000_000;
const START = HEAD - BACKFILL_BLOCKS; // 830,000: the first run's cursor
const A = addr(0xa1);
const B = addr(0xb2);
const C = addr(0xc3);
const POOL_A = addr(0x1a1);
const V4_ID = `0x${"a6".repeat(32)}` as const;
const HOOK = addr(0x4040);

const indexerDoc = async () => (await db.collection(COLLECTIONS.indexer).doc("mainnet").get()).data() as IndexerDoc;
const tokenDoc = async (a: string) => (await db.collection(COLLECTIONS.tokens).doc(tokenId("mainnet", a)).get()).data() as TokenDoc | undefined;
const feed = async (filter: "all" | "liquid" | "passing" | "liquid-passing") =>
  (await db.collection(COLLECTIONS.radarFeed).doc(radarFeedId("mainnet", filter)).get()).data() as RadarFeedDoc | undefined;
const count = async (collection: string) => (await db.collection(collection).count().get()).data().count;

/** The indexer doc as a first run on a chain whose head was HEAD leaves it: the cursor at START. */
async function startAt(block: number, over: Partial<IndexerDoc> = {}) {
  await db.collection(COLLECTIONS.indexer).doc("mainnet").set({
    network: "mainnet", block, updatedAt: Timestamp.now(), lastRunAt: null, paused: false, inspect: true, halted: null,
    explorerCalls: { day: "2026-10-01", count: 0 }, ...over,
  } satisfies IndexerDoc);
}

type Ran = Extract<RunResult, { status: "ran" }>;
const clock = fakeNow();
function run(chain: FakeChainOptions | ReturnType<typeof fakeChain>, inspector: InspectToken = fakeInspector({}), settings = { inspectPerTick: 3, explorerDailyBudget: 5_000 }) {
  const c = "logs" in chain && typeof chain.logs === "function" ? (chain as ReturnType<typeof fakeChain>) : fakeChain(chain as FakeChainOptions);
  return runIndexer({ db, network: "mainnet", chain: c, inspectToken: inspector, settings, now: clock.now });
}
const ran = (r: RunResult) => r as Ran;

describe("the windows", () => {
  it("starts 24 hours back, reads at most 10 windows of 10,000 blocks a run, and catches up on the next", async () => {
    const chain = fakeChain({ head: HEAD });
    const first = ran(await run(chain, fakeInspector({}), { inspectPerTick: 0, explorerDailyBudget: 0 }));
    expect(first).toMatchObject({ status: "ran", head: HEAD, from: START, to: START + 100_000, windows: 10 });
    expect(chain.asked[0]).toEqual({ from: START + 1, to: START + 10_000 });
    expect(chain.asked.every(({ from, to }) => to - from + 1 === 10_000)).toBe(true);
    expect((await indexerDoc()).block).toBe(START + 100_000);

    const second = ran(await run({ head: HEAD }));
    expect(second).toMatchObject({ from: START + 100_000, to: HEAD, windows: 7 });
    const third = ran(await run({ head: HEAD }));
    expect(third).toMatchObject({ from: HEAD, to: HEAD, windows: 0 });
  });

  it("starts no window after 40 s, and no inspection after 80 s", async () => {
    await startAt(START);
    const slow = fakeChain({ head: START + 100_000, logs: [v3Pool(START + 5, A, POOL_A)] });
    const logs = slow.logs;
    slow.logs = async (filter) => {
      clock.advance(15_000);
      return logs(filter);
    };
    const inspector = fakeInspector({});
    const result = ran(await run(slow, inspector));
    // Windows start at 0, 15 and 30 s; a fourth would start at 45 s. The queue still runs at 45 s.
    expect(result.windows).toBe(3);
    expect(inspector.calls).toHaveLength(1);

    const later = fakeChain({ head: START + 100_000 });
    later.logs = async () => {
      clock.advance(85_000);
      return [];
    };
    const idle = fakeInspector({});
    expect(ran(await run(later, idle)).windows).toBe(1);
    expect(idle.calls).toEqual([]);
  });

  it("creates the console controls at their defaults on the first run", async () => {
    await run({ head: HEAD });
    expect(await indexerDoc()).toMatchObject({ network: "mainnet", paused: false, inspect: true, halted: null, explorerCalls: { count: 0 } });
    expect((await indexerDoc()).lastRunAt).toBeInstanceOf(Timestamp);
  });

  it("does nothing while paused, not even ask for the head", async () => {
    await run({ head: HEAD });
    await db.collection(COLLECTIONS.indexer).doc("mainnet").update({ paused: true });
    const chain = fakeChain({ head: HEAD + 50_000 });
    expect(await run(chain)).toEqual({ status: "paused" });
    expect(chain.heads).toBe(0);
    expect(chain.asked).toEqual([]);
  });

  it("halves a refused window until the node takes it, and keeps every block covered once", async () => {
    const chain = fakeChain({ head: START + 12_000, maxSpan: 2_500 });
    await startAt(START);
    const result = ran(await run(chain, fakeInspector({}), { inspectPerTick: 0, explorerDailyBudget: 0 }));
    const answered = chain.asked.filter(({ from, to }) => to - from + 1 <= 2_500);
    expect(chain.asked[0]).toEqual({ from: START + 1, to: START + 10_000 });
    expect(answered[0]).toEqual({ from: START + 1, to: START + 2_500 });
    // Covered in order, without a gap, as far as the run got.
    answered.reduce((at, w) => (expect(w.from).toBe(at + 1), w.to), START);
    expect((await indexerDoc()).block).toBe(result.to);
    expect(result.to).toBe(answered.at(-1)!.to);
  });

  it("halts itself when the node refuses even one block, and stays halted", async () => {
    await startAt(START);
    const chain = fakeChain({ head: START + 10, refuseBlock: START + 1 });
    const halted = await run(chain);
    expect(halted).toEqual({ status: "halted", reason: `eth_getLogs refused the single block ${START + 1}` });
    expect((await indexerDoc()).halted).toBe(halted.status === "halted" ? halted.reason : null);
    const after = fakeChain({ head: START + 10 });
    expect(await run(after)).toMatchObject({ status: "halted" });
    expect(after.asked).toEqual([]);
  });

  it("never skips a window: a failed call ends the run with the cursor at the last window written", async () => {
    const logs = [v3Pool(START + 5, A, POOL_A), v3Pool(START + 25_000, B, addr(0x1b2))];
    await startAt(START);
    const crashing = fakeChain({ head: START + 30_000, logs, failCall: 3 });
    const first = ran(await run(crashing));
    expect(first.to).toBe(START + 20_000);
    expect(await tokenDoc(A)).toBeDefined();
    expect(await tokenDoc(B)).toBeUndefined();
    const second = ran(await run({ head: START + 30_000, logs }));
    expect(second).toMatchObject({ from: START + 20_000, to: START + 30_000, tokens: 1 });
    expect(await tokenDoc(B)).toBeDefined();
  });
});

describe("pools and tokens", () => {
  const logs = () => [
    v3Pool(START + 100, A, POOL_A),
    v4Pool(START + 200, A, V4_ID, HOOK, 1),
    created(START + 5_000, B, "BEE"),
    // A USDC/EURC pool: two quotes and no token, so nothing is recorded.
    // C against native USDC, on v4.
    v4Pool(START + 300, C, `0x${"cc".repeat(32)}`),
    { ...v3Pool(START + 400, addr(0xd4), addr(0x1d4)), topics: v3Pool(START + 400, addr(0xd4), addr(0x1d4)).topics.map((t, i) => (i === 1 ? `0x${"0".repeat(24)}${EURC.mainnet.slice(2).toLowerCase()}` as const : t)) },
  ];

  it("records a pool only with a quote on one side, and its token once, with what the log says", async () => {
    await startAt(START);
    const result = ran(await run({ head: START + 10_000, logs: logs() }, fakeInspector({}), { inspectPerTick: 0, explorerDailyBudget: 0 }));
    expect(result).toMatchObject({ pools: 3, tokens: 3 });

    const pools = (await db.collection(COLLECTIONS.pools).get()).docs.map((d) => d.data() as PoolDoc);
    expect(pools.map((p) => [p.version, p.token, p.quote]).sort()).toEqual([
      ["v3", A, "USDC"],
      ["v4", A, "USDC-native"],
      ["v4", C, "USDC-native"],
    ]);
    const v4 = (await db.collection(COLLECTIONS.pools).doc(poolId("mainnet", V4_ID)).get()).data() as PoolDoc;
    expect(v4).toMatchObject({ poolId: V4_ID, createdBlock: START + 200, fee: 10_000, key: { currency0: ZERO, currency1: A, fee: 10_000, tickSpacing: 200, hooks: HOOK } });

    expect(await tokenDoc(A)).toMatchObject({
      source: "v3", firstBlock: START + 100, name: null, report: null, radar: { liquid: false, passing: false },
      inspect: { state: "queued", priority: INSPECT_PRIORITY.pooled, attempts: 0 },
    });
    expect((await tokenDoc(A))!.firstSeen.toMillis()).toBe(timeOf(START + 100) * 1000);
    expect(await tokenDoc(B)).toMatchObject({
      source: "factory", name: "BEE token", symbol: "BEE", decimals: 18, totalSupply: (10n ** 24n).toString(), creator: addr(0xc0ffee),
      inspect: { state: "queued", priority: INSPECT_PRIORITY.bare },
    });
    expect(await tokenDoc(addr(0xd4))).toBeUndefined();
  });

  it("writes the first Radar page of every filter, newest first", async () => {
    await startAt(START);
    await run({ head: START + 10_000, logs: logs() }, fakeInspector({}), { inspectPerTick: 0, explorerDailyBudget: 0 });
    expect((await feed("all"))!.rows.map((r) => r.address)).toEqual([B, C, A]);
    expect((await feed("liquid"))!.rows).toEqual([]);
    expect((await feed("liquid-passing"))!.rows).toEqual([]);
  });

  it("writes nothing new when a window is read again", async () => {
    await startAt(START);
    await run({ head: START + 10_000, logs: logs() }, fakeInspector({}), { inspectPerTick: 0, explorerDailyBudget: 0 });
    const before = await db.collection(COLLECTIONS.tokens).get();
    await db.collection(COLLECTIONS.indexer).doc("mainnet").update({ block: START });
    const again = ran(await run({ head: START + 10_000, logs: logs() }, fakeInspector({}), { inspectPerTick: 0, explorerDailyBudget: 0 }));
    expect(again).toMatchObject({ pools: 0, tokens: 0, requeued: 0, feeds: 0 });
    const after = await db.collection(COLLECTIONS.tokens).get();
    expect(after.docs.map((d) => d.updateTime.toMillis())).toEqual(before.docs.map((d) => d.updateTime.toMillis()));
    expect(await count(COLLECTIONS.pools)).toBe(3);
  });

  it("leaves new tokens skipped while the console's inspect switch is off", async () => {
    await startAt(START, { inspect: false });
    const inspector = fakeInspector({});
    await run({ head: START + 10_000, logs: logs() }, inspector);
    expect(await tokenDoc(A)).toMatchObject({ inspect: { state: "skipped", queuedAt: null } });
    expect(inspector.calls).toEqual([]);
  });
});

describe("the inspection queue", () => {
  const liquidPool: Pool = { address: "0x8366a39CC670B4001A1121B8F6A443A643e40951", version: "v4", quote: "USDC", depth: 1_234_000_000n, liquid: true, poolId: V4_ID };
  const scan = { pools: [liquidPool], factoriesAnswered: true, silent: [] };

  async function seed(head = START + 10_000) {
    await startAt(START);
    const logs = [v3Pool(START + 100, A, POOL_A), v4Pool(START + 200, A, V4_ID, HOOK, 1), created(START + 300, B, "BEE"), v3Pool(START + 400, C, addr(0x1c3))];
    await run({ head, logs }, fakeInspector({}), { inspectPerTick: 0, explorerDailyBudget: 0 });
    return logs;
  }

  it("inspects the pooled tokens before the bare one, newest first, and stores what Radar reads", async () => {
    await seed();
    const inspector = fakeInspector({
      [A]: { report: fakeReport(A, 6, true), scan },
      [C]: { report: fakeReport(C, 2, false), scan: { pools: [], factoriesAnswered: true, silent: [] } },
    });
    const result = ran(await run({ head: START + 10_000 }, inspector, { inspectPerTick: 2, explorerDailyBudget: 5_000 }));
    expect(result).toMatchObject({ inspected: 2, failed: 0 });
    expect(inspector.calls.map((c) => c.token)).toEqual([C, A]);
    // The index's v4 pool, hook and all, goes to the inspection as an extra pool.
    expect(inspector.calls[1]!.extraPools).toEqual([{ version: "v4", key: { currency0: ZERO, currency1: A, fee: 10_000, tickSpacing: 200, hooks: HOOK } }]);

    const a = (await tokenDoc(A))!;
    expect(a).toMatchObject({
      name: "Inspected", symbol: "INS", decimals: 18, totalSupply: "1000",
      report: { passed: 6, total: 8, counts: { pass: 6, warn: 0, fail: 0, unknown: 2 }, block: 23_900_000 },
      radar: { liquid: true, passing: true },
      bestPool: { id: V4_ID, version: "v4", depthUsdc: "1234000000" },
      inspect: { state: "done", queuedAt: null },
    });
    expect(await tokenDoc(C)).toMatchObject({ radar: { liquid: false, passing: false }, bestPool: null, inspect: { state: "done" } });
    expect(await tokenDoc(B)).toMatchObject({ inspect: { state: "queued" } });

    const report = (await db.collection(COLLECTIONS.reports).doc(tokenId("mainnet", A)).get()).data() as ReportDoc;
    expect(report).toMatchObject({ network: "mainnet", address: A, passed: 6, total: 8, degraded: false, explorerReachable: true });
    expect(report.report).toEqual(JSON.parse(JSON.stringify(fakeReport(A, 6, true))));
    expect(report.expiresAt.toMillis() - report.createdAt.toMillis()).toBe(TTL_MS.reports);

    expect((await feed("liquid-passing"))!.rows.map((r) => [r.address, r.passed, r.bestPoolDepth])).toEqual([[A, 6, "1234000000"]]);
    expect((await feed("all"))!.rows.map((r) => r.address)).toEqual([C, B, A]);
  });

  it("queues a liquid token again, ahead of new ones, when a new pool appears for it", async () => {
    const logs = await seed();
    await run({ head: START + 10_000 }, fakeInspector({ [A]: { report: fakeReport(A, 6, true), scan }, [C]: { report: fakeReport(C, 1, false) } }), {
      inspectPerTick: 2,
      explorerDailyBudget: 5_000,
    });
    const more = [...logs, v3Pool(START + 15_000, A, addr(0x2a1)), v3Pool(START + 16_000, addr(0xe5), addr(0x1e5))];
    const result = ran(await run({ head: START + 20_000, logs: more }, fakeInspector({}), { inspectPerTick: 0, explorerDailyBudget: 0 }));
    expect(result).toMatchObject({ pools: 2, tokens: 1, requeued: 1 });
    expect(await tokenDoc(A)).toMatchObject({ inspect: { state: "queued", priority: INSPECT_PRIORITY.liquid }, radar: { liquid: true } });
    const next = fakeInspector({ [A]: { report: fakeReport(A, 6, true), scan } });
    await run({ head: START + 20_000 }, next, { inspectPerTick: 1, explorerDailyBudget: 5_000 });
    expect(next.calls.map((c) => c.token)).toEqual([A]);
  });

  it("counts explorer calls against the day's budget, and inspects on RPC only once it is spent", async () => {
    await seed();
    const answers = { [A]: { report: fakeReport(A, 6, true), scan }, [B]: { report: fakeReport(B, 1, false) }, [C]: { report: fakeReport(C, 2, false) } };
    const inspector = fakeInspector(answers, 3);
    const result = ran(await run({ head: START + 10_000 }, inspector, { inspectPerTick: 3, explorerDailyBudget: 5 }));
    expect(result.explorerCalls).toBe(5);
    expect(inspector.calls.map((c) => c.budget === null)).toEqual([false, false, true]);
    const degraded = (await db.collection(COLLECTIONS.reports).doc(tokenId("mainnet", B)).get()).data() as ReportDoc;
    expect(degraded.degraded).toBe(true);
    expect((await indexerDoc()).explorerCalls).toEqual({ day: "2026-10-02", count: 5 });

    // A new UTC day starts the count again.
    clock.advance(24 * 60 * 60 * 1000);
    await db.collection(COLLECTIONS.tokens).doc(tokenId("mainnet", A)).update({ "inspect.state": "queued", "inspect.queuedAt": Timestamp.fromMillis(clock.now()) });
    await run({ head: START + 10_000 }, fakeInspector(answers, 1), { inspectPerTick: 1, explorerDailyBudget: 5 });
    expect((await indexerDoc()).explorerCalls).toEqual({ day: "2026-10-03", count: 1 });
  });

  it("tries a failed inspection again, three times at most; a token with no contract is skipped at once", async () => {
    await seed();
    const notAContract = Object.assign(new Error("no code"), { name: "NotAContract" });
    for (let i = 1; i <= 3; i++) {
      const result = ran(await run({ head: START + 10_000 }, fakeInspector({ [A]: new Error("timeout"), [B]: { report: fakeReport(B, 1, false) }, [C]: notAContract }), { inspectPerTick: 2, explorerDailyBudget: 0 }));
      expect(result.failed).toBe(i === 1 ? 2 : 1);
      if (i === 1) expect(await tokenDoc(C)).toMatchObject({ inspect: { state: "skipped", attempts: 1 } });
    }
    expect(await tokenDoc(A)).toMatchObject({ inspect: { state: "skipped", attempts: 3, queuedAt: null } });
  });

  it("skips a token that waited 24 hours without inspecting it", async () => {
    await seed();
    clock.advance(INSPECT_QUEUE_MAX_AGE_MS);
    const inspector = fakeInspector({});
    const result = ran(await run({ head: START + 10_000 }, inspector));
    expect(result.expired).toBe(3);
    expect(inspector.calls).toEqual([]);
    expect(await tokenDoc(B)).toMatchObject({ inspect: { state: "skipped", queuedAt: null } });
  });
});

describe("the doc shapes", () => {
  it("keeps USDC's address lowercase in every key, as the ids are", () => {
    expect(USDC_LOWER).toBe("0x3600000000000000000000000000000000000000");
  });
});
