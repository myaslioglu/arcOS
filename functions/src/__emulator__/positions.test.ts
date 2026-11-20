import { deleteApp, getApps } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { UNISWAP_V4 } from "@arcos/chain";
import { COLLECTIONS, DATABASE_ID, positionId, positionsIndexId, type IndexerDoc, type PositionDoc, type PositionsIndexDoc } from "@arcos/data";
import { arcosDb, indexedPositions, indexedPositionsFor } from "@arcos/data/server";
import { v4PoolId, v4PoolKey } from "@arcos/inspector";
import { applyPositionsWindow, decodePositionLogs, ensurePositionsIndex } from "../indexer/positions-store";
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
    expect(await apply({ from: 1_000, to: 1_999 }, logs)).toEqual({ kind: "applied", block: 1_999, written: 2 });
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
    expect(await apply({ from: 2_000, to: 2_999 }, [modifyLiquidity(2_500, POOL, NFTS, 1n, -5n), modifyLiquidity(2_600, POOL, NFTS, 2n)])).toEqual({ kind: "applied", block: 2_999, written: 1 });
    expect((await stored()).map((d) => d.firstBlock).sort()).toEqual([1_010, 2_600]);
  });

  it("repeats a window whose positions were stored but whose cursor wasn't moved, without duplicating anything", async () => {
    await ensurePositionsIndex(db, "mainnet", 1_000, NOW, 5_000);
    const logs = [modifyLiquidity(1_010, POOL, NFTS, 1n)];
    // A run that died after the positions and before the cursor: the docs are there, the cursor is not.
    await db.collection(COLLECTIONS.positions).doc(positionId("mainnet", POOL, decodePositionLogs(logs, PM, { from: 1_000, to: 1_999 })[0]!.key)).set({ marker: "from the dead run" });
    expect(await apply({ from: 1_000, to: 1_999 }, logs)).toEqual({ kind: "applied", block: 1_999, written: 0 });
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
    expect(await apply({ from: 1_000, to: 1_999 }, logs)).toEqual({ kind: "applied", block: 1_999, written: 950 });
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
    expect(result.positions).toEqual({ windows: 3, positions: 4, behind: 0, error: null });
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
    expect(again.positions).toEqual({ windows: 0, positions: 0, behind: 0, error: null });
    expect(await stored()).toEqual(before);
  });

  it("stops at the window cap, says how far behind it is, and the next run carries on", async () => {
    await stateAt(HEAD);
    const first = await go(fakeChain({ head: HEAD, logs }), { fromBlock: START, limits: { maxWindows: 2 } });
    expect(first.positions).toEqual({ windows: 2, positions: 3, behind: 5_001, error: null });
    expect((await cursorDoc())?.block).toBe(START + 19_999);
    const second = await go(fakeChain({ head: HEAD, logs }), { fromBlock: START, limits: { maxWindows: 2 } });
    expect(second.positions).toEqual({ windows: 1, positions: 1, behind: 0, error: null });
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
    expect(result.positions).toEqual({ windows: 0, positions: 0, behind: 0, error: null });
    expect(chain.asked).toEqual([]);
    expect(await cursorDoc()).toBeUndefined();
  });

  it("reads nothing, and writes no cursor, when the console switch is off; runs when it is true or missing", async () => {
    await stateAt(HEAD, { positions: false });
    const chain = fakeChain({ head: HEAD, logs });
    expect((await go(chain)).positions).toBeNull();
    expect(chain.asked).toEqual([]);
    expect(await cursorDoc()).toBeUndefined();
    await stateAt(HEAD, { positions: true });
    expect((await go(fakeChain({ head: HEAD, logs }))).positions).not.toBeNull();
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

  it("names a window that can't be read, keeps what it stored, and repeats that window on the next run", async () => {
    await stateAt(HEAD);
    const result = await go(fakeChain({ head: HEAD, logs, failCall: 2 }));
    expect(result.status).toBe("ran");
    expect(result.positions).toEqual({ windows: 1, positions: 2, behind: 15_001, error: "Error" });
    expect(result.error).toBe("Error");
    const next = fakeChain({ head: HEAD, logs });
    expect((await go(next)).positions).toEqual({ windows: 2, positions: 2, behind: 0, error: null });
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
    // The hooked pool from the index and the standard hookless keys the Inspector also probes: 5 tiers against USDC, EURC
    // and native USDC, each with an entry, an empty one where the index holds nothing.
    expect(Object.keys(extras.v4Positions!.pools)).toHaveLength(16);
    expect(extras.v4Positions!.pools[hookedId]).toEqual({ positions: [{ owner: HOOK, tickLower: -600, tickUpper: 600, salt: `0x${"0".repeat(64)}` }], truncated: false });
    expect(extras.v4Positions!.pools[standard]!.positions).toHaveLength(1);
    expect(extras.v4Positions!.pools[POOL]).toBeUndefined();
    expect(await indexedPositionsFor(db, "mainnet", [hookedId])).toMatchObject({ cursor: 1_999 });
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
    expect(result.positions).toEqual({ windows: 1, positions: 1, behind: 0, error: null });
    expect((await cursorDoc())?.block).toBe(2_010);
  });
});
