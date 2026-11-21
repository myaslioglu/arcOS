import { deleteApp, getApps } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { UNISWAP_V4 } from "@arcos/chain";
import { COLLECTIONS, DATABASE_ID, poolId, positionId, positionsIndexId, tokenId, type IndexerDoc, type PoolDoc, type PositionDoc, type PositionsIndexDoc } from "@arcos/data";
import { arcosDb, indexedPools, indexedPositions, indexedPositionsFor } from "@arcos/data/server";
import { v4PoolId, v4PoolKey } from "@arcos/inspector";
import { applyPositionsWindow, decodePoolLogs, decodePositionLogs, ensurePositionsIndex } from "../indexer/positions-store";
import { runPositions } from "../indexer/positions-run";
import { indexedExtras, runIndexer, type RunResult } from "../indexer/run";
import { ZERO, addr, fakeChain, fakeInspector, fakeNow, fakeReport, modifyLiquidity, v4Pool } from "./fakes";

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

const PM = UNISWAP_V4.poolManager;
const NFTS = UNISWAP_V4.positionManager;
const POOL = `0x${"a1".repeat(32)}` as const;
const OTHER = `0x${"b2".repeat(32)}` as const;
const NOW = Date.parse("2026-11-20T12:00:00Z");
const cursorDoc = async () => (await db.collection(COLLECTIONS.positionsIndex).doc(positionsIndexId("mainnet")).get()).data() as PositionsIndexDoc | undefined;
const stored = async () => (await db.collection(COLLECTIONS.positions).get()).docs.map((d) => ({ id: d.id, ...(d.data() as PositionDoc), writeTime: d.updateTime.toMillis() }));
const withoutWriteTime = (docs: Awaited<ReturnType<typeof stored>>) => docs.map((doc) => Object.fromEntries(Object.entries(doc).filter(([field]) => field !== "writeTime")));
const apply = (window: { from: number; to: number }, logs: ReturnType<typeof modifyLiquidity>[], tip = 5_000) =>
  applyPositionsWindow(db, "mainnet", window, decodePositionLogs(logs, PM, window), { tip, now: NOW });

describe("applyPositionsWindow", () => {
  it("creates the cursor one block before the start, so the start block's logs are read", async () => {
    expect(await ensurePositionsIndex(db, "mainnet", 1_000, NOW, 5_000)).toMatchObject({ network: "mainnet", block: 999, fromBlock: 1_000, head: 5_000 });
    // A second call finds it, raises the head and changes nothing else.
    await ensurePositionsIndex(db, "mainnet", 5, NOW + 1, 6_000);
    expect(await cursorDoc()).toMatchObject({ block: 999, fromBlock: 1_000, head: 6_000 });
    await ensurePositionsIndex(db, "mainnet", 5, NOW + 2, 5_500);
    expect((await cursorDoc())?.head).toBe(6_000);
  });

  it("stores one doc per position under its key, with the NFT's id for a PositionManager position, and moves the cursor", async () => {
    await ensurePositionsIndex(db, "mainnet", 1_000, NOW, 5_000);
    const logs = [modifyLiquidity(1_010, POOL, NFTS, 332_087n, 10n ** 18n, -887_250, 887_250), modifyLiquidity(1_020, POOL, addr(0xf0d6), 0n), modifyLiquidity(1_500, POOL, NFTS, 332_087n, -(10n ** 18n), -887_250, 887_250)];
    expect(await apply({ from: 1_000, to: 1_999 }, logs)).toEqual({ kind: "applied", block: 1_999, written: 2, pools: 0 });
    const docs = await stored();
    const salt = `0x${(332_087).toString(16).padStart(64, "0")}`;
    expect(withoutWriteTime(docs).sort((a, b) => Number(a.firstBlock) - Number(b.firstBlock))).toEqual([
      {
        id: positionId("mainnet", POOL, { owner: NFTS, tickLower: -887_250, tickUpper: 887_250, salt }),
        network: "mainnet", poolId: POOL, owner: NFTS.toLowerCase(), tickLower: -887_250, tickUpper: 887_250, salt, tokenId: "332087", firstBlock: 1_010,
      },
      {
        id: positionId("mainnet", POOL, { owner: addr(0xf0d6), tickLower: -600, tickUpper: 600, salt: `0x${"0".repeat(64)}` }),
        network: "mainnet", poolId: POOL, owner: addr(0xf0d6), tickLower: -600, tickUpper: 600, salt: `0x${"0".repeat(64)}`, tokenId: null, firstBlock: 1_020,
      },
    ]);
    // No amount of liquidity is stored: the check reads it live.
    expect(JSON.stringify(docs)).not.toMatch(/liquidity|delta/i);
    expect(await cursorDoc()).toMatchObject({ block: 1_999, head: 5_000 });
  });

  it("changes nothing when a window is applied again: no doc is rewritten and the cursor stays", async () => {
    await ensurePositionsIndex(db, "mainnet", 1_000, NOW, 5_000);
    const logs = [modifyLiquidity(1_010, POOL, NFTS, 1n), modifyLiquidity(1_020, POOL, NFTS, 2n)];
    await apply({ from: 1_000, to: 1_999 }, logs);
    const before = await stored();
    const cursorBefore = await cursorDoc();
    expect(await apply({ from: 1_000, to: 1_999 }, logs)).toEqual({ kind: "already", block: 1_999 });
    expect(await stored()).toEqual(before);
    expect(await cursorDoc()).toEqual(cursorBefore);
  });

  it("keeps a position's first block when a later window names it again", async () => {
    await ensurePositionsIndex(db, "mainnet", 1_000, NOW, 5_000);
    await apply({ from: 1_000, to: 1_999 }, [modifyLiquidity(1_010, POOL, NFTS, 1n)]);
    expect(await apply({ from: 2_000, to: 2_999 }, [modifyLiquidity(2_500, POOL, NFTS, 1n, -5n), modifyLiquidity(2_600, POOL, NFTS, 2n)])).toEqual({ kind: "applied", block: 2_999, written: 1, pools: 0 });
    expect((await stored()).map((d) => d.firstBlock).sort()).toEqual([1_010, 2_600]);
  });

  it("repeats a window whose positions were stored but whose cursor wasn't moved, without duplicating anything", async () => {
    await ensurePositionsIndex(db, "mainnet", 1_000, NOW, 5_000);
    const logs = [modifyLiquidity(1_010, POOL, NFTS, 1n)];
    // A run that died after the positions and before the cursor: the docs are there, the cursor is not.
    await db.collection(COLLECTIONS.positions).doc(positionId("mainnet", POOL, decodePositionLogs(logs, PM, { from: 1_000, to: 1_999 })[0]!.key)).set({ marker: "from the dead run" });
    expect(await apply({ from: 1_000, to: 1_999 }, logs)).toEqual({ kind: "applied", block: 1_999, written: 0, pools: 0 });
    expect(await stored()).toHaveLength(1);
  });

  it("doesn't move a cursor that isn't where the window starts, and says where it is", async () => {
    await ensurePositionsIndex(db, "mainnet", 1_000, NOW, 5_000);
    expect(await apply({ from: 1_500, to: 1_999 }, [])).toEqual({ kind: "moved", block: 999 });
    expect((await cursorDoc())?.block).toBe(999);
    await db.collection(COLLECTIONS.positionsIndex).doc(positionsIndexId("mainnet")).delete();
    expect(await apply({ from: 1_000, to: 1_999 }, [])).toEqual({ kind: "missing" });
  });

  it("stores a window with more positions than one batch holds", async () => {
    await ensurePositionsIndex(db, "mainnet", 1_000, NOW, 5_000);
    const logs = Array.from({ length: 950 }, (_, i) => modifyLiquidity(1_000 + i, POOL, NFTS, BigInt(i + 1)));
    expect(await apply({ from: 1_000, to: 1_999 }, logs)).toEqual({ kind: "applied", block: 1_999, written: 950, pools: 0 });
    expect(await indexedPositions(db, "mainnet", POOL)).toMatchObject({ truncated: true, cursor: 1_999 });
    expect((await indexedPositions(db, "mainnet", POOL, 1_000)).positions).toHaveLength(950);
  });
});

describe("the position index's step of a run", () => {
  const clock = fakeNow(NOW);
  const START = 5_000_000;
  const HEAD = START + 25_000;
  const stateAt = async (block: number, over: Partial<IndexerDoc> = {}) => {
    await db.collection(COLLECTIONS.indexer).doc("mainnet").set({
      network: "mainnet", block, updatedAt: Timestamp.now(), lastRunAt: null, paused: false, inspect: true, halted: null,
      explorerCalls: { day: "2026-11-20", count: 0 }, runningUntil: null, runId: null, ...over,
    } satisfies IndexerDoc);
  };
  type Ran = Extract<RunResult, { status: "ran" }>;
  const go = async (chain: ReturnType<typeof fakeChain>, positions: Record<string, unknown> | null = { fromBlock: START }, network: "mainnet" | "testnet" = "mainnet") =>
    (await runIndexer({
      db, network, chain, inspectToken: fakeInspector({}), settings: { inspectPerTick: 0, explorerDailyBudget: 0 }, now: clock.now,
      ...(positions ? { positions } : {}),
    })) as Ran;
  const logs = [
    modifyLiquidity(START, POOL, NFTS, 1n),
    modifyLiquidity(START + 5, POOL, NFTS, 2n),
    modifyLiquidity(START + 12_000, OTHER, addr(0xf0d6), 0n),
    modifyLiquidity(START + 12_001, POOL, NFTS, 1n, -(10n ** 18n)),
    modifyLiquidity(START + 24_000, POOL, NFTS, 3n),
  ];

  it("starts at the given block, stores each window's positions once, and reports counts only", async () => {
    await stateAt(HEAD);
    const chain = fakeChain({ head: HEAD, logs });
    const result = await go(chain);
    expect(result.positions).toEqual({ windows: 3, positions: 4, pools: 0, behind: 0, error: null });
    expect(result.error).toBeNull();
    expect(chain.asked).toEqual([
      { from: START, to: START + 9_999 },
      { from: START + 10_000, to: START + 19_999 },
      { from: START + 20_000, to: START + 25_000 },
    ]);
    expect(await cursorDoc()).toMatchObject({ block: HEAD, fromBlock: START, head: HEAD });
    expect((await indexedPositions(db, "mainnet", POOL)).positions).toHaveLength(3);
    expect((await indexedPositions(db, "mainnet", OTHER)).positions).toEqual([{ owner: addr(0xf0d6), tickLower: -600, tickUpper: 600, salt: `0x${"0".repeat(64)}` }]);
    // The next run has nothing new to read, and writes nothing.
    const before = await stored();
    const again = await go(fakeChain({ head: HEAD, logs }));
    expect(again.positions).toEqual({ windows: 0, positions: 0, pools: 0, behind: 0, error: null });
    expect(await stored()).toEqual(before);
  });

  it("stops at the window cap, says how far behind it is, and the next run carries on", async () => {
    await stateAt(HEAD);
    const first = await go(fakeChain({ head: HEAD, logs }), { fromBlock: START, limits: { maxWindows: 2 } });
    expect(first.positions).toEqual({ windows: 2, positions: 3, pools: 0, behind: 5_001, error: null });
    expect((await cursorDoc())?.block).toBe(START + 19_999);
    const second = await go(fakeChain({ head: HEAD, logs }), { fromBlock: START, limits: { maxWindows: 2 } });
    expect(second.positions).toEqual({ windows: 1, positions: 1, pools: 0, behind: 0, error: null });
  });

  it("starts no window after its time limit, nor after its own budget", async () => {
    await stateAt(HEAD);
    const real = fakeChain({ head: HEAD, logs: [] });
    const slow = { ...real, logs: async (f: Parameters<typeof real.logs>[0]) => { clock.advance(30_000); return real.logs(f); } };
    const byClock = await go(slow as unknown as ReturnType<typeof fakeChain>, { fromBlock: START, limits: { untilMs: 50_000, stepMs: 1_000_000 } });
    // Windows begin at 0 s and 30 s; the one that would begin at 60 s doesn't.
    expect(byClock.positions).toMatchObject({ windows: 2, behind: 5_001 });
    await reset();
    await stateAt(HEAD);
    const fresh = fakeChain({ head: HEAD, logs: [] });
    const slower = { ...fresh, logs: async (f: Parameters<typeof fresh.logs>[0]) => { clock.advance(30_000); return fresh.logs(f); } };
    const byStep = await go(slower as unknown as ReturnType<typeof fakeChain>, { fromBlock: START, limits: { untilMs: 10_000_000, stepMs: 20_000 } });
    expect(byStep.positions).toMatchObject({ windows: 1, behind: 15_001 });
  });

  it("doesn't start at all once the run is past the step's time", async () => {
    await stateAt(HEAD);
    const chain = fakeChain({ head: HEAD, logs });
    const result = await go(chain, { fromBlock: START, limits: { untilMs: 0 } });
    expect(result.positions).toEqual({ windows: 0, positions: 0, pools: 0, behind: 0, error: null, reason: "no-time" });
    expect(chain.asked).toEqual([]);
    expect(await cursorDoc()).toBeUndefined();
  });

  it("says so, and how far behind it really is, when a run leaves it no time: a starved step doesn't read as caught up", async () => {
    await stateAt(HEAD);
    await ensurePositionsIndex(db, "mainnet", START, NOW, HEAD);
    const chain = fakeChain({ head: HEAD, logs });
    const result = await go(chain, { fromBlock: START, limits: { untilMs: 0 } });
    expect(result.positions).toEqual({ windows: 0, positions: 0, pools: 0, behind: HEAD - START + 1, error: null, reason: "no-time" });
    expect(chain.asked).toEqual([]);
    // Nothing was written: no marker, the cursor where it was.
    expect((await cursorDoc())?.attempt).toBeUndefined();
    expect((await cursorDoc())?.block).toBe(START - 1);
  });

  it("reads nothing, and writes no cursor, when the console switch is off; runs when it is true or missing", async () => {
    await stateAt(HEAD, { positions: false });
    const chain = fakeChain({ head: HEAD, logs });
    expect((await go(chain)).positions).toEqual({ windows: 0, positions: 0, pools: 0, behind: 0, error: null, reason: "off" });
    expect(chain.asked).toEqual([]);
    expect(await cursorDoc()).toBeUndefined();
    // Off with a cursor already there: the distance it has fallen behind is reported, and nothing else happens.
    await ensurePositionsIndex(db, "mainnet", START, NOW, HEAD);
    expect((await go(fakeChain({ head: HEAD, logs }))).positions).toEqual({ windows: 0, positions: 0, pools: 0, behind: HEAD - START + 1, error: null, reason: "off" });
    await reset();
    await stateAt(HEAD, { positions: true });
    expect((await go(fakeChain({ head: HEAD, logs }))).positions).not.toBeNull();
  });

  describe("its place in the run", () => {
    // Stats counts from a block of its own, far from the position index's, so the order of the windows asked for
    // says which step went first.
    const STATS_FROM = HEAD - 500;
    const both = async (chain: ReturnType<typeof fakeChain>) =>
      (await runIndexer({
        db, network: "mainnet", chain, inspectToken: fakeInspector({}), settings: { inspectPerTick: 0, explorerDailyBudget: 0 }, now: clock.now,
        positions: { fromBlock: START }, stats: { from: { block: STATS_FROM, at: "2026-11-20" } },
      })) as Ran;
    const firstOf = (chain: ReturnType<typeof fakeChain>) => (chain.asked[0]!.from < STATS_FROM ? "positions" : "stats");

    it("goes before Stats while it is more than 10,000 blocks behind the head, and on its first run", async () => {
      await stateAt(HEAD);
      const first = fakeChain({ head: HEAD, logs });
      expect((await both(first)).positions).toMatchObject({ error: null });
      expect(firstOf(first)).toBe("positions");
      expect(first.asked.some((w) => w.from >= STATS_FROM)).toBe(true);
      // Put back 10,001 blocks behind: first again.
      await db.collection(COLLECTIONS.positionsIndex).doc(positionsIndexId("mainnet")).update({ block: HEAD - 10_001 });
      const behind = fakeChain({ head: HEAD, logs });
      await both(behind);
      expect(firstOf(behind)).toBe("positions");
    });

    it("goes after Stats, as before, once it is within 10,000 blocks", async () => {
      await stateAt(HEAD);
      await ensurePositionsIndex(db, "mainnet", START, NOW, HEAD);
      await db.collection(COLLECTIONS.positionsIndex).doc(positionsIndexId("mainnet")).update({ block: HEAD - 10_000 });
      const chain = fakeChain({ head: HEAD, logs });
      expect((await both(chain)).positions).toMatchObject({ windows: 1, behind: 0, error: null });
      expect(firstOf(chain)).toBe("stats");
      expect(chain.asked[chain.asked.length - 1]).toEqual({ from: HEAD - 9_999, to: HEAD });
    });
  });

  it("is skipped when the run is given no settings for it", async () => {
    await stateAt(HEAD);
    const chain = fakeChain({ head: HEAD, logs });
    expect((await go(chain, null)).positions).toBeNull();
    expect(chain.asked).toEqual([]);
  });

  it("halves a window the node refuses and still stores every position once", async () => {
    await stateAt(HEAD);
    const chain = fakeChain({ head: START + 7_999, logs: [modifyLiquidity(START + 1_000, POOL, NFTS, 1n), modifyLiquidity(START + 3_000, POOL, NFTS, 2n), modifyLiquidity(START + 6_000, POOL, NFTS, 3n)], maxSpan: 2_500 });
    await stateAt(START + 7_999);
    const result = await go(chain);
    expect(result.positions).toMatchObject({ positions: 3, behind: 0, error: null });
    expect(chain.asked.some((w) => w.to - w.from + 1 > 2_500)).toBe(true);
    expect((await indexedPositions(db, "mainnet", POOL)).positions).toHaveLength(3);
  });

  it("takes the width the node suggests when it refuses, and starts the next run from the width that worked", async () => {
    await stateAt(START + 29_999);
    const many = [modifyLiquidity(START + 1_000, POOL, NFTS, 1n), modifyLiquidity(START + 12_000, POOL, NFTS, 2n), modifyLiquidity(START + 25_000, POOL, NFTS, 3n)];
    const chain = fakeChain({ head: START + 29_999, logs: many, maxSpan: 9_473, suggest: 9_473 });
    const first = await go(chain, { fromBlock: START, limits: { maxWindows: 2 } });
    expect(first.positions).toMatchObject({ windows: 2, positions: 2, error: null });
    // One refusal at the cap, then the hint, not half of the cap, and nothing wider again in this run.
    expect(chain.asked.map((w) => w.to - w.from + 1)).toEqual([10_000, 9_473, 9_473]);
    expect((await db.collection(COLLECTIONS.positionsIndex).doc(positionsIndexId("mainnet")).get()).data()).toMatchObject({ span: 9_473, block: START + 18_945 });
    // The next run doesn't begin at 10,000 again.
    const next = fakeChain({ head: START + 29_999, logs: many, maxSpan: 9_473, suggest: 9_473 });
    expect((await go(next, { fromBlock: START, limits: { maxWindows: 1 } })).positions).toMatchObject({ windows: 1, positions: 1, error: null });
    expect(next.asked[0]).toEqual({ from: START + 18_946, to: START + 28_418 });
  });

  it("names a window that can't be read, keeps what it stored, and repeats that window on the next run", async () => {
    await stateAt(HEAD);
    const result = await go(fakeChain({ head: HEAD, logs, failCall: 2 }));
    expect(result.status).toBe("ran");
    expect(result.positions).toEqual({ windows: 1, positions: 2, pools: 0, behind: 15_001, error: "Error" });
    expect(result.error).toBe("Error");
    const next = fakeChain({ head: HEAD, logs });
    expect((await go(next)).positions).toEqual({ windows: 2, positions: 2, pools: 0, behind: 0, error: null });
    expect(next.asked[0]).toEqual({ from: START + 10_000, to: START + 19_999 });
  });

  it("keeps its own cursor: the indexer's and Stats' are untouched, and they don't hold it back", async () => {
    await stateAt(HEAD - 3);
    const result = await go(fakeChain({ head: HEAD, logs }));
    expect(result.to).toBe(HEAD);
    expect((await db.collection(COLLECTIONS.indexer).doc("mainnet").get()).data()?.block).toBe(HEAD);
    expect((await cursorDoc())?.block).toBe(HEAD);
    expect((await db.collection(COLLECTIONS.stats).get()).size).toBe(0);
  });
});

describe("the pools the position index's step completes", () => {
  const clock = fakeNow(NOW);
  const START = 5_000_000;
  // The main indexer began at MAIN_START: what is older than that, it never saw.
  const MAIN_START = START + 20_000;
  const HEAD = START + 25_000;
  const OLD = addr(0x01d0);
  const NEWER = addr(0x0e3e);
  const HOOK = addr(0x2544);
  const oldHooked = v4PoolId(v4PoolKey(ZERO, OLD, 10_000, 200, HOOK));
  const oldOddFee = `0x${"0d".repeat(32)}` as const;
  const newerPool = `0x${"e3".repeat(32)}` as const;
  const stateAt = async (block: number) => {
    await db.collection(COLLECTIONS.indexer).doc("mainnet").set({
      network: "mainnet", block, updatedAt: Timestamp.now(), lastRunAt: null, paused: false, inspect: true, halted: null,
      explorerCalls: { day: "2026-11-20", count: 0 }, runningUntil: null, runId: null,
    } satisfies IndexerDoc);
  };
  type Ran = Extract<RunResult, { status: "ran" }>;
  const go = async (chain: ReturnType<typeof fakeChain>, limits?: Record<string, number>) =>
    (await runIndexer({
      db, network: "mainnet", chain, inspectToken: fakeInspector({}), settings: { inspectPerTick: 0, explorerDailyBudget: 0 }, now: clock.now,
      positions: { fromBlock: START }, ...(limits ? { limits } : {}),
    })) as Ran;
  const pool = async (id: string) => (await db.collection(COLLECTIONS.pools).doc(poolId("mainnet", id)).get()).data() as PoolDoc | undefined;
  const count = async (name: string) => (await db.collection(name).get()).size;

  it("adds a pool doc for every v4 pool from before the main indexer's first block, hook and all, and nothing else", async () => {
    await stateAt(HEAD);
    const logs = [
      v4Pool(START + 10, OLD, oldHooked, HOOK),
      v4Pool(START + 11, OLD, oldOddFee),
      modifyLiquidity(START + 12, oldHooked, NFTS, 5n),
      // A pool of two quote currencies has no token: the pool index keeps none of those.
      { ...v4Pool(START + 13, ZERO, `0x${"99".repeat(32)}`), topics: [v4Pool(0, ZERO, POOL).topics[0]!, `0x${"99".repeat(32)}` as const, v4Pool(0, ZERO, POOL).topics[2]!, `0x${"3600".padEnd(40, "0").padStart(64, "0")}` as const] },
    ];
    const result = await go(fakeChain({ head: HEAD, logs }));
    expect(result.positions).toEqual({ windows: 3, positions: 1, pools: 2, behind: 0, error: null });
    expect(await pool(oldHooked)).toEqual({
      network: "mainnet", poolId: oldHooked, version: "v4", token: OLD, quote: "USDC-native", fee: 10_000, createdBlock: START + 10,
      key: { currency0: ZERO, currency1: OLD, fee: 10_000, tickSpacing: 200, hooks: HOOK }, depthUsdc: null, sampledAt: null,
    });
    expect((await indexedPools(db, "mainnet", OLD)).map((p) => p.poolId).sort()).toEqual([oldOddFee, oldHooked].sort());
    // Pool docs only: no token, so nothing queued for inspection and nothing for Radar.
    expect(await count(COLLECTIONS.tokens)).toBe(0);
    for (const feed of (await db.collection(COLLECTIONS.radarFeed).get()).docs) expect(feed.data().rows).toEqual([]);
    expect(result).toMatchObject({ pools: 0, tokens: 0, requeued: 0 });
    // And an inspection of the token now gets the hooked pool, with its positions.
    const extras = await indexedExtras(db, "mainnet", OLD);
    expect(extras.extraPools.map((p) => p.key.hooks)).toContain(HOOK);
    expect(extras.v4Positions?.pools[oldHooked]?.positions).toHaveLength(1);
  });

  it("writes nothing the second time, and leaves a pool the main indexer recorded exactly as it is", async () => {
    await stateAt(HEAD);
    const mine: PoolDoc = {
      network: "mainnet", poolId: newerPool, version: "v4", token: NEWER, quote: "USDC-native", fee: 10_000, createdBlock: MAIN_START + 5,
      key: { currency0: ZERO, currency1: NEWER, fee: 10_000, tickSpacing: 200, hooks: ZERO }, depthUsdc: "123456789", sampledAt: Timestamp.fromMillis(NOW),
    };
    await db.collection(COLLECTIONS.pools).doc(poolId("mainnet", newerPool)).set(mine);
    const logs = [v4Pool(START + 10, OLD, oldHooked, HOOK), v4Pool(MAIN_START + 5, NEWER, newerPool)];
    expect((await go(fakeChain({ head: HEAD, logs }))).positions).toMatchObject({ pools: 1 });
    expect(await pool(newerPool)).toEqual(mine);
    const writeTime = (await db.collection(COLLECTIONS.pools).doc(poolId("mainnet", oldHooked)).get()).updateTime?.toMillis();
    // The window again, from a cursor moved back: both docs are there, so neither is written.
    await db.collection(COLLECTIONS.positionsIndex).doc(positionsIndexId("mainnet")).update({ block: START - 1 });
    expect((await go(fakeChain({ head: HEAD, logs }))).positions).toMatchObject({ windows: 3, pools: 0 });
    expect((await db.collection(COLLECTIONS.pools).doc(poolId("mainnet", oldHooked)).get()).updateTime?.toMillis()).toBe(writeTime);
    expect(await pool(newerPool)).toEqual(mine);
  });

  it("never reads past the main indexer's cursor, so a new pool is the main indexer's to record, token and all", async () => {
    // The main indexer is behind and reads one window a run: its cursor ends this run at MAIN_START + 10,000.
    await stateAt(MAIN_START);
    const far = MAIN_START + 30_000;
    const logs = [v4Pool(START + 10, OLD, oldHooked, HOOK), v4Pool(MAIN_START + 15_000, NEWER, newerPool), modifyLiquidity(MAIN_START + 15_001, newerPool, NFTS, 9n)];
    const first = await go(fakeChain({ head: far, logs }), { maxWindows: 1 });
    expect(first.to).toBe(MAIN_START + 10_000);
    expect(first.positions).toEqual({ windows: 4, positions: 0, pools: 1, behind: 20_000, error: null });
    expect((await cursorDoc())?.block).toBe(MAIN_START + 10_000);
    // The newer pool is past both cursors: no doc of it yet, and no token.
    expect(await pool(newerPool)).toBeUndefined();
    // The next run: the main indexer reaches it first, records the pool and queues its token; the position index follows.
    const second = await go(fakeChain({ head: far, logs }), { maxWindows: 1 });
    expect(second).toMatchObject({ pools: 1, tokens: 1, to: MAIN_START + 20_000 });
    expect(second.positions).toEqual({ windows: 1, positions: 1, pools: 0, behind: 10_000, error: null });
    expect((await db.collection(COLLECTIONS.tokens).doc(tokenId("mainnet", NEWER)).get()).data()).toMatchObject({ inspect: { state: "queued" } });
    expect(await pool(newerPool)).toMatchObject({ token: NEWER, createdBlock: MAIN_START + 15_000 });
  });

  it("can't write over a pool doc that appeared after it looked: the write is a create, and after a refusal it looks again", async () => {
    await ensurePositionsIndex(db, "mainnet", START, NOW, HEAD);
    const window = { from: START, to: START + 9_999 };
    const logs = [v4Pool(START + 10, OLD, oldHooked, HOOK)];
    const pools = decodePoolLogs(logs, "mainnet", window);
    const mine = { ...pools[0]!, quoteDepth: "77" };
    await db.collection(COLLECTIONS.pools).doc(poolId("mainnet", oldHooked)).set(mine);
    // The step's own read misses the doc, as when the main indexer writes it between that read and the write.
    let looks = 0;
    const blind = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "getAll") return Reflect.get(target, prop, receiver) as unknown;
        return async (...refs: Parameters<typeof target.getAll>) => {
          const snaps = await target.getAll(...refs);
          return looks++ > 0 ? snaps : snaps.map((snap) => new Proxy(snap, { get: (t, p, r) => (p === "exists" ? false : (Reflect.get(t, p, r) as unknown)) }));
        };
      },
    });
    expect(await applyPositionsWindow(blind, "mainnet", window, [], { tip: HEAD, now: NOW, pools })).toEqual({ kind: "applied", block: START + 9_999, written: 0, pools: 0 });
    expect(await pool(oldHooked)).toEqual(mine);
  });

  it("stores a window of thousands of new pools in rounds, stops when its time is up, and goes on from there the next time", async () => {
    await ensurePositionsIndex(db, "mainnet", START, NOW, HEAD);
    const window = { from: START, to: START + 9_999 };
    // 5,000 pools and 5,000 positions in one window: 13 chunks of each, three rounds of each.
    const ids = Array.from({ length: 5_000 }, (_, i) => `0x${(i + 1).toString(16).padStart(64, "0")}` as const);
    const logs = ids.flatMap((poolIdOf, i) => [v4Pool(START + 10, addr(0x10_0000 + i), poolIdOf, HOOK), modifyLiquidity(START + 11, poolIdOf, NFTS, BigInt(i + 1))]);
    const pools = decodePoolLogs(logs, "mainnet", window);
    const positions = decodePositionLogs(logs, UNISWAP_V4.poolManager, window);
    expect([pools.length, positions.length]).toEqual([5_000, 5_000]);
    // A clock that moves a second each time it is asked, and a budget of four rounds: the positions' three and one of the pools'.
    let ticks = 0;
    const clock = () => NOW + 1_000 * ticks++;
    const began = Date.now();
    const first = await applyPositionsWindow(db, "mainnet", window, positions, { tip: HEAD, now: NOW, pools, until: NOW + 4_000, clock });
    expect(first).toEqual({ kind: "unfinished", written: 5_000, pools: 2_400 });
    expect((await db.collection(COLLECTIONS.positionsIndex).doc("mainnet").get()).data()).toMatchObject({ block: START - 1 });
    // The next run: nothing is written twice, the rest is, and the cursor moves.
    const second = await applyPositionsWindow(db, "mainnet", window, positions, { tip: HEAD, now: NOW, pools });
    expect(second).toEqual({ kind: "applied", block: START + 9_999, written: 0, pools: 2_600 });
    expect(await count(COLLECTIONS.pools)).toBe(5_000);
    expect(await count(COLLECTIONS.positions)).toBe(5_000);
    // 10,000 docs, most of them twice over, in well under a run's budget even here.
    expect(Date.now() - began).toBeLessThan(60_000);
  }, 90_000);

  it("runPositions leaves an unfinished window to the next run, without an error", async () => {
    await stateAt(HEAD);
    const ids = Array.from({ length: 1_000 }, (_, i) => `0x${(i + 1).toString(16).padStart(64, "0")}` as const);
    const logs = ids.map((poolIdOf, i) => v4Pool(START + 10, addr(0x10_0000 + i), poolIdOf, HOOK));
    // No round of writes may start: the budget for them is already spent.
    const first = (await runIndexer({
      db, network: "mainnet", chain: fakeChain({ head: HEAD, logs }), inspectToken: fakeInspector({}), settings: { inspectPerTick: 0, explorerDailyBudget: 0 }, now: clock.now,
      positions: { fromBlock: START, limits: { writeUntilMs: 0 } },
    })) as Ran;
    expect(first.positions).toEqual({ windows: 0, positions: 0, pools: 0, behind: HEAD - START + 1, error: null });
    const second = await go(fakeChain({ head: HEAD, logs }));
    expect(second.positions).toMatchObject({ pools: 1_000, behind: 0, error: null });
  }, 60_000);

  it("stores a window's pools before its cursor moves: a run that died in between adds nothing twice", async () => {
    await ensurePositionsIndex(db, "mainnet", START, NOW, HEAD);
    const window = { from: START, to: START + 9_999 };
    const logs = [v4Pool(START + 10, OLD, oldHooked, HOOK)];
    const pools = decodePoolLogs(logs, "mainnet", window);
    await db.collection(COLLECTIONS.pools).doc(poolId("mainnet", oldHooked)).set(pools[0]!);
    expect(await applyPositionsWindow(db, "mainnet", window, [], { tip: HEAD, now: NOW, pools })).toEqual({ kind: "applied", block: START + 9_999, written: 0, pools: 0 });
    expect(await count(COLLECTIONS.pools)).toBe(1);
  });
});

describe("what the index hands an inspection", () => {
  const TOKEN = addr(0x70c3);
  const HOOK = addr(0x2544);
  const hooked = v4PoolKey(ZERO, TOKEN, 10_000, 200, HOOK);
  const hookedId = v4PoolId(hooked);
  const standard = v4PoolId(v4PoolKey(ZERO, TOKEN, 2_500, 50));

  it("is the token's indexed pools, and the positions of its v4 pools under the index's cursor", async () => {
    await db.collection(COLLECTIONS.pools).doc(`mainnet:${hookedId}`).set({
      network: "mainnet", poolId: hookedId, version: "v4", token: TOKEN, quote: "USDC-native", fee: 10_000, createdBlock: 900,
      key: { currency0: ZERO, currency1: TOKEN, fee: 10_000, tickSpacing: 200, hooks: HOOK }, depthUsdc: null, sampledAt: null,
    });
    await ensurePositionsIndex(db, "mainnet", 1_000, NOW, 5_000);
    await apply({ from: 1_000, to: 1_999 }, [modifyLiquidity(1_010, hookedId, HOOK, 0n), modifyLiquidity(1_020, standard, NFTS, 9n), modifyLiquidity(1_030, POOL, NFTS, 1n)]);

    const extras = await indexedExtras(db, "mainnet", TOKEN);
    expect(extras.extraPools).toEqual([{ version: "v4", key: { currency0: ZERO, currency1: TOKEN, fee: 10_000, tickSpacing: 200, hooks: HOOK } }]);
    expect(extras.v4Positions?.cursor).toBe(1_999);
    // Only the pools the index lists for the token are looked up: a standard key nobody recorded a pool for is not.
    expect(Object.keys(extras.v4Positions!.pools)).toEqual([hookedId]);
    expect(extras.v4Positions!.pools[hookedId]).toEqual({ positions: [{ owner: HOOK, tickLower: -600, tickUpper: 600, salt: `0x${"0".repeat(64)}` }], truncated: false });
    expect(extras.v4Positions!.pools[standard]).toBeUndefined();
    expect(extras.v4Positions!.pools[POOL]).toBeUndefined();
    expect(extras).not.toHaveProperty("extraPoolsTruncated");
    expect(await indexedPositionsFor(db, "mainnet", [hookedId])).toMatchObject({ cursor: 1_999 });
  });

  const reads = () => {
    const asked: string[] = [];
    const counting = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "collection") return (name: string) => (asked.push(name), target.collection(name));
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    return { asked, counting };
  };

  it("asks for no positions of a token the index lists no pool for: an address nobody indexed costs one pools query", async () => {
    await ensurePositionsIndex(db, "mainnet", 1_000, NOW, 5_000);
    const { asked, counting } = reads();
    expect(await indexedExtras(counting, "mainnet", addr(0xdead_beef))).toEqual({ extraPools: [], v4Positions: { cursor: 999, pools: {} } });
    expect(asked.filter((name) => name === COLLECTIONS.positions)).toEqual([]);
  });

  it("says when the token has more pools than it lists", async () => {
    await ensurePositionsIndex(db, "mainnet", 1_000, NOW, 5_000);
    const MANY = addr(0x3a17);
    for (let i = 0; i < 51; i++) {
      const id = `0x${i.toString(16).padStart(64, "0")}`;
      await db.collection(COLLECTIONS.pools).doc(`mainnet:${id}`).set({
        network: "mainnet", poolId: id, version: "v4", token: MANY, quote: "USDC-native", fee: 3_000 + i, createdBlock: 900,
        key: { currency0: ZERO, currency1: MANY, fee: 3_000 + i, tickSpacing: 60, hooks: ZERO }, depthUsdc: null, sampledAt: null,
      });
    }
    const extras = await indexedExtras(db, "mainnet", MANY);
    expect(extras.extraPools).toHaveLength(50);
    expect(extras.extraPoolsTruncated).toBe(true);
  });

  it("goes on without the positions when their read fails or outlasts its time, and says so once", async () => {
    await db.collection(COLLECTIONS.pools).doc(`mainnet:${hookedId}`).set({
      network: "mainnet", poolId: hookedId, version: "v4", token: TOKEN, quote: "USDC-native", fee: 10_000, createdBlock: 900,
      key: { currency0: ZERO, currency1: TOKEN, fee: 10_000, tickSpacing: 200, hooks: HOOK }, depthUsdc: null, sampledAt: null,
    });
    await ensurePositionsIndex(db, "mainnet", 1_000, NOW, 5_000);
    const warned: object[] = [];
    const log = { warn: (_m: string, data?: object) => void warned.push(data ?? {}) };
    // A read that never answers: the extras come back after the read's own time, pools and all.
    const hung = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "getAll") return () => new Promise(() => {});
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const started = Date.now();
    const slow = await indexedExtras(hung, "mainnet", TOKEN, log, 200);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(slow.extraPools).toHaveLength(1);
    expect(slow).not.toHaveProperty("v4Positions");
    expect(warned).toEqual([expect.objectContaining({ error: "PositionsReadTimeout" })]);
    const failing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "getAll") return () => Promise.reject(Object.assign(new Error("7 PERMISSION_DENIED"), { code: 7 }));
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    expect(await indexedExtras(failing, "mainnet", TOKEN, log, 200)).toEqual({ extraPools: slow.extraPools });
  });

  it("hands over no positions while the switch is off, so the inspection runs the old check at once", async () => {
    await db.collection(COLLECTIONS.pools).doc(`mainnet:${hookedId}`).set({
      network: "mainnet", poolId: hookedId, version: "v4", token: TOKEN, quote: "USDC-native", fee: 10_000, createdBlock: 900,
      key: { currency0: ZERO, currency1: TOKEN, fee: 10_000, tickSpacing: 200, hooks: HOOK }, depthUsdc: null, sampledAt: null,
    });
    await ensurePositionsIndex(db, "mainnet", 1_000, NOW, 5_000);
    await db.collection(COLLECTIONS.indexer).doc("mainnet").set({ network: "mainnet", block: 1, positions: false });
    expect(await indexedExtras(db, "mainnet", TOKEN)).toEqual({ extraPools: [{ version: "v4", key: { currency0: ZERO, currency1: TOKEN, fee: 10_000, tickSpacing: 200, hooks: HOOK } }] });
    await db.collection(COLLECTIONS.indexer).doc("mainnet").update({ positions: true });
    expect((await indexedExtras(db, "mainnet", TOKEN)).v4Positions?.cursor).toBe(999);
  });

  it("is the pools alone before the position index's first run, and on testnet", async () => {
    expect(await indexedExtras(db, "mainnet", TOKEN)).toEqual({ extraPools: [] });
    await ensurePositionsIndex(db, "mainnet", 1_000, NOW, 5_000);
    expect(await indexedExtras(db, "testnet", TOKEN)).toEqual({ extraPools: [] });
  });

  it("reaches the inspector in a run: the token's pools and positions go with the inspection", async () => {
    const clock = fakeNow(NOW);
    await db.collection(COLLECTIONS.indexer).doc("mainnet").set({
      network: "mainnet", block: 2_000, updatedAt: Timestamp.now(), lastRunAt: null, paused: false, inspect: true, halted: null,
      explorerCalls: { day: "2026-11-20", count: 0 }, runningUntil: null, runId: null,
    } satisfies IndexerDoc);
    await ensurePositionsIndex(db, "mainnet", 1_000, NOW, 2_000);
    await apply({ from: 1_000, to: 2_000 }, [modifyLiquidity(1_500, hookedId, NFTS, 77n)]);
    const inspector = fakeInspector({ [TOKEN]: { report: fakeReport(TOKEN, 6, true) } });
    const chain = fakeChain({ head: 2_010, logs: [v4Pool(2_005, TOKEN, hookedId, HOOK), modifyLiquidity(2_006, hookedId, NFTS, 78n)] });
    const result = (await runIndexer({ db, network: "mainnet", chain, inspectToken: inspector, settings: { inspectPerTick: 3, explorerDailyBudget: 10 }, now: clock.now, positions: { fromBlock: 1_000 } })) as Extract<RunResult, { status: "ran" }>;
    expect(result.inspected).toBe(1);
    // The inspection ran before this run's own positions step: it got the index as the last run left it, and reads the
    // blocks since the cursor itself.
    expect(inspector.calls[0]!.v4Positions).toEqual({
      cursor: 2_000,
      pools: expect.objectContaining({ [hookedId]: { positions: [{ owner: NFTS.toLowerCase(), tickLower: -600, tickUpper: 600, salt: `0x${(77).toString(16).padStart(64, "0")}` }], truncated: false } }) as unknown,
    });
    expect(result.positions).toEqual({ windows: 1, positions: 1, pools: 0, behind: 0, error: null });
    expect((await cursorDoc())?.block).toBe(2_010);
  });
});

describe("a window too large for the time a run has left", () => {
  const START = 7_000_000;
  const HEAD = START + 9_999;
  const cursorDoc = async () => (await db.collection(COLLECTIONS.positionsIndex).doc(positionsIndexId("mainnet")).get()).data() as PositionsIndexDoc;
  const quiet = { warn: () => undefined, error: () => undefined };
  /** One run of the step alone, on a clock that moves a second every time it is asked. */
  const run = (chain: ReturnType<typeof fakeChain>, writeUntilMs: number) => {
    let ticks = 0;
    return runPositions({
      db, network: "mainnet", chain, tip: HEAD, indexed: HEAD, now: () => NOW + 1_000 * ticks++, started: NOW, elapsed: () => 0, log: quiet,
      deps: { fromBlock: START, limits: { writeUntilMs, maxWindows: 1 } },
    });
  };

  it("converges through the halved width: a run that can start one round of writes never finishes 10,000 blocks, and does finish 2,500", async () => {
    // 6,000 positions spread evenly over the window: 15 chunks, three rounds of writes at full width.
    const logs = Array.from({ length: 6_000 }, (_, i) => modifyLiquidity(START + Math.floor((i * 10_000) / 6_000), POOL, NFTS, BigInt(i + 1)));
    // The budget: whatever the first round of writes starts within, and nothing after it.
    let budget = 0;
    for (let ms = 1_000; ms <= 12_000 && budget === 0; ms += 1_000) {
      await reset();
      const probe = await run(fakeChain({ head: HEAD, logs }), ms);
      if (probe.positions > 0) budget = ms;
    }
    expect(budget).toBeGreaterThan(0);
    await reset();
    const spans: (number | undefined)[] = [];
    const cursors: number[] = [];
    for (let i = 0; i < 12; i++) {
      const result = await run(fakeChain({ head: HEAD, logs }), budget);
      expect(result.error).toBeNull();
      const doc = await cursorDoc();
      spans.push(doc.span);
      cursors.push(doc.block);
      if (doc.block === HEAD) break;
    }
    // The first run stores the first round and stops, the cursor where it was, the width halved; so does the second.
    expect(cursors.slice(0, 2)).toEqual([START - 1, START - 1]);
    expect(spans.slice(0, 2)).toEqual([5_000, 2_500]);
    // From there windows fit, and the cursor gets to the head: every position stored once.
    expect(cursors[cursors.length - 1]).toBe(HEAD);
    expect((await db.collection(COLLECTIONS.positions).get()).size).toBe(6_000);
  }, 110_000);

  it("moves the cursor when the last docs were stored just past the time given", async () => {
    await ensurePositionsIndex(db, "mainnet", START, NOW, HEAD);
    const window = { from: START, to: HEAD };
    const positions = decodePositionLogs([modifyLiquidity(START + 5, POOL, NFTS, 1n), modifyLiquidity(START + 6, POOL, NFTS, 2n)], PM, window);
    // The one round starts in time; by the time it is done the time is up.
    let asked = 0;
    const clock = () => (asked++ === 0 ? NOW : NOW + 60_000);
    expect(await applyPositionsWindow(db, "mainnet", window, positions, { tip: HEAD, now: NOW, until: NOW + 5_000, clock })).toEqual({ kind: "applied", block: HEAD, written: 2, pools: 0 });
    expect((await cursorDoc()).block).toBe(HEAD);
  });

  it("halves the width, and keeps the cursor, when a window's logs don't arrive in time", async () => {
    const logs = [modifyLiquidity(START + 100, POOL, NFTS, 1n), modifyLiquidity(START + 7_000, POOL, NFTS, 2n)];
    const first = await run(fakeChain({ head: HEAD, logs, slowAbove: 5_000 }), 1_000_000);
    expect(first).toMatchObject({ windows: 0, positions: 0, error: "DeadlineExceeded" });
    expect(await cursorDoc()).toMatchObject({ block: START - 1, span: 5_000 });
    const chain = fakeChain({ head: HEAD, logs, slowAbove: 5_000 });
    expect(await run(chain, 1_000_000)).toMatchObject({ windows: 1, positions: 1, error: null });
    expect(chain.asked).toEqual([{ from: START, to: START + 4_999 }]);
    // A refusal still takes the node's hint, and is not this: nothing is stored for it.
    await reset();
    const refused = fakeChain({ head: HEAD, logs, maxSpan: 9_000, suggest: 9_000 });
    expect(await run(refused, 1_000_000)).toMatchObject({ windows: 1, error: null });
    expect((await cursorDoc()).span).toBe(9_000);
  });
});

describe("a run killed on a window leaves word, and the next reads half as wide", () => {
  const START = 8_000_000;
  const HEAD = START + 39_999;
  const cursorDoc = async () => (await db.collection(COLLECTIONS.positionsIndex).doc(positionsIndexId("mainnet")).get()).data() as PositionsIndexDoc;
  const quiet = { warn: () => undefined, error: () => undefined };
  const logs = [modifyLiquidity(START + 100, POOL, NFTS, 1n), modifyLiquidity(START + 7_000, POOL, NFTS, 2n), modifyLiquidity(START + 15_000, POOL, NFTS, 3n), modifyLiquidity(START + 30_000, POOL, NFTS, 4n)];
  class Killed extends Error {}
  /** One run of the step. `dieAbove`: the function is killed (nothing after the marker happens) on any window wider than this. */
  const run = async (dieAbove: number, maxWindows = 12) => {
    const chain = fakeChain({ head: HEAD, logs });
    const result = runPositions({
      db, network: "mainnet", chain, tip: HEAD, indexed: HEAD, now: () => NOW, started: NOW, elapsed: () => 0, log: quiet,
      deps: { fromBlock: START, limits: { maxWindows }, onAttempt: ({ width }) => { if (width > dieAbove) throw new Killed(); } },
    });
    return { chain, result };
  };

  it("writes the window down before reading it, and halves it when the run never came back", async () => {
    const first = await run(5_000);
    await expect(first.result).rejects.toBeInstanceOf(Killed);
    // Nothing was read, nothing stored but the marker.
    expect(first.chain.asked).toEqual([]);
    expect(await cursorDoc()).toMatchObject({ block: START - 1, attempt: { from: START, width: 10_000, at: NOW } });
    expect((await cursorDoc()).span).toBeUndefined();

    const second = await run(5_000, 1);
    expect(await second.result).toMatchObject({ windows: 1, positions: 1, error: null });
    expect(second.chain.asked).toEqual([{ from: START, to: START + 4_999 }]);
    const doc = await cursorDoc();
    expect(doc).toMatchObject({ block: START + 4_999, span: 5_000, ceiling: 5_000, ceilingUntil: START + 9_999 });
    expect(doc.attempt).toBeUndefined();
  });

  it("converges under repeated kills, and holds the ceiling until the cursor is past the window that died", async () => {
    // Only 1,250 blocks at a time survive.
    const widths: number[] = [];
    for (let i = 0; i < 4; i++) {
      const attempt = await run(1_250, 1);
      const outcome = await attempt.result.then(() => "ran", () => "killed");
      widths.push((await cursorDoc()).attempt?.width ?? 0);
      if (outcome === "ran") break;
    }
    // 10,000, 5,000 and 2,500 died; 1,250 applied and took its marker with it.
    expect(widths).toEqual([10_000, 5_000, 2_500, 0]);
    expect(await cursorDoc()).toMatchObject({ block: START + 1_249, span: 1_250, ceiling: 1_250, ceilingUntil: START + 9_999 });

    // With the danger past (nothing kills now), the width still doesn't grow before the cursor passes START + 9,999.
    const careful = await run(Infinity);
    expect(await careful.result).toMatchObject({ error: null });
    const asked = careful.chain.asked.map((w) => ({ width: w.to - w.from + 1, to: w.to }));
    for (const w of asked.filter((x) => x.to <= START + 9_999)) expect(w.width).toBeLessThanOrEqual(1_250);
    expect(asked.filter((x) => x.to <= START + 9_999)).toHaveLength(7);
    // Past it the width doubles again with each window.
    const after = asked.filter((x) => x.to > START + 9_999).map((x) => x.width);
    expect(after.slice(0, 3)).toEqual([2_500, 5_000, 10_000]);
    expect((await db.collection(COLLECTIONS.positions).get()).size).toBe(4);
  });

  it("a refused window the run then had no time to narrow is not a kill either: its marker is cleared", async () => {
    // The node refuses 10,000 blocks; the step may make one pass only, so it stops before reading a narrower window.
    const chain = fakeChain({ head: HEAD, logs, maxSpan: 4_000 });
    const result = await runPositions({ db, network: "mainnet", chain, tip: HEAD, indexed: HEAD, now: () => NOW, started: NOW, elapsed: () => 0, log: quiet, deps: { fromBlock: START, limits: { maxWindows: 0.5 } } });
    expect(result).toMatchObject({ windows: 0, error: null });
    expect(chain.asked).toEqual([{ from: START, to: START + 9_999 }]);
    const doc = await cursorDoc();
    expect(doc.attempt).toBeUndefined();
    expect(doc.span).toBeUndefined();
    expect(doc.ceiling).toBeUndefined();
  });

  it("a marker older than ten minutes is not the last run's: the step was off, and nothing is halved", async () => {
    await ensurePositionsIndex(db, "mainnet", START, NOW, HEAD);
    const ref = db.collection(COLLECTIONS.positionsIndex).doc(positionsIndexId("mainnet"));
    await ref.update({ attempt: { from: START, width: 10_000, at: NOW - 11 * 60_000 } });
    const old = await run(Infinity, 1);
    await old.result;
    expect(old.chain.asked).toEqual([{ from: START, to: START + 9_999 }]);
    // Nine minutes old, it is: half as wide.
    await reset();
    await ensurePositionsIndex(db, "mainnet", START, NOW, HEAD);
    await ref.update({ attempt: { from: START, width: 10_000, at: NOW - 9 * 60_000 } });
    const recent = await run(Infinity, 1);
    await recent.result;
    expect(recent.chain.asked).toEqual([{ from: START, to: START + 4_999 }]);
  });

  it("a failure the step saw is not a kill: the marker goes, and the width stays", async () => {
    const chain = fakeChain({ head: HEAD, logs, failCall: 1 });
    const result = await runPositions({ db, network: "mainnet", chain, tip: HEAD, indexed: HEAD, now: () => NOW, started: NOW, elapsed: () => 0, log: quiet, deps: { fromBlock: START } });
    expect(result).toMatchObject({ windows: 0, error: "Error" });
    expect((await cursorDoc()).attempt).toBeUndefined();
    const next = await run(Infinity, 1);
    await next.result;
    expect(next.chain.asked).toEqual([{ from: START, to: START + 9_999 }]);
  });
});
