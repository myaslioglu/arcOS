import { deleteApp, getApps } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { COLLECTIONS, positionDoc, positionId, positionsIndexId, type PositionsIndexDoc } from "../index";
import { arcosDb, indexedPositions, indexedPositionsFor, readPositionsCursor } from "../server";

afterAll(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

const POOL_A = `0x${"a1".repeat(32)}`;
const POOL_B = `0x${"b2".repeat(32)}`;
const POOL_NONE = `0x${"c3".repeat(32)}`;
const OWNER = "0x00000000000000000000000000000000000a11ce";
const salt = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

async function put(network: "mainnet" | "testnet", pool: string, n: number): Promise<void> {
  const key = { owner: OWNER, tickLower: -60, tickUpper: 60, salt: salt(n) };
  await arcosDb().collection(COLLECTIONS.positions).doc(positionId(network, pool, key)).set(positionDoc(network, pool, key, 100 + n));
}
const setCursor = (block: number, network: "mainnet" | "testnet" = "mainnet") =>
  arcosDb()
    .collection(COLLECTIONS.positionsIndex)
    .doc(positionsIndexId(network))
    .set({ network, block, fromBlock: 1, head: block + 3, updatedAt: Timestamp.fromMillis(1_790_000_000_000) } satisfies PositionsIndexDoc);

// The emulator keeps what other suites wrote: start from an empty index.
beforeEach(async () => {
  const db = arcosDb();
  for (const name of [COLLECTIONS.positions, COLLECTIONS.positionsIndex]) {
    const snap = await db.collection(name).get();
    await Promise.all(snap.docs.map((doc) => doc.ref.delete()));
  }
});

describe("readPositionsCursor", () => {
  it("is null before the index's first run, then the block it has reached, per network", async () => {
    expect(await readPositionsCursor(arcosDb(), "mainnet")).toBeNull();
    await setCursor(32_000_000);
    expect(await readPositionsCursor(arcosDb(), "mainnet")).toBe(32_000_000);
    expect(await readPositionsCursor(arcosDb(), "testnet")).toBeNull();
  });
});

describe("indexedPositions", () => {
  it("returns the pool's position keys on the network asked, with the cursor, and nothing else", async () => {
    await setCursor(500);
    await put("mainnet", POOL_A, 1);
    await put("mainnet", POOL_A, 2);
    await put("mainnet", POOL_B, 3);
    await put("testnet", POOL_A, 4);

    const found = await indexedPositions(arcosDb(), "mainnet", POOL_A.toUpperCase().replace("0X", "0x"));
    expect(found.cursor).toBe(500);
    expect(found.truncated).toBe(false);
    expect(found.positions.map((p) => p.salt).sort()).toEqual([salt(1), salt(2)]);
    expect(found.positions[0]).toEqual({ owner: OWNER, tickLower: -60, tickUpper: 60, salt: found.positions[0]!.salt });
  });

  it("says truncated when the pool has more than the limit, and not when it has exactly the limit", async () => {
    await setCursor(500);
    for (let n = 1; n <= 3; n++) await put("mainnet", POOL_A, n);
    expect(await indexedPositions(arcosDb(), "mainnet", POOL_A, 2)).toMatchObject({ truncated: true, positions: [{}, {}] });
    expect(await indexedPositions(arcosDb(), "mainnet", POOL_A, 3)).toMatchObject({ truncated: false, positions: [{}, {}, {}] });
  });

  it("finds nothing for a pool without positions, and has no cursor before the first run", async () => {
    expect(await indexedPositions(arcosDb(), "mainnet", POOL_NONE)).toEqual({ positions: [], truncated: false, cursor: null });
  });

  it("writing a position again changes nothing: the id is the key", async () => {
    await put("mainnet", POOL_A, 1);
    await put("mainnet", POOL_A, 1);
    expect((await indexedPositions(arcosDb(), "mainnet", POOL_A)).positions).toHaveLength(1);
  });
});

describe("indexedPositionsFor", () => {
  it("is null before the index's first run", async () => {
    await put("mainnet", POOL_A, 1);
    expect(await indexedPositionsFor(arcosDb(), "mainnet", [POOL_A])).toBeNull();
  });

  it("answers every pool asked for under one cursor, an empty entry for a pool the index holds nothing for", async () => {
    await setCursor(700);
    await put("mainnet", POOL_A, 1);
    await put("mainnet", POOL_B, 2);
    await put("mainnet", POOL_B, 3);
    const found = await indexedPositionsFor(arcosDb(), "mainnet", [POOL_A, POOL_B.toUpperCase().replace("0X", "0x"), POOL_NONE, POOL_A]);
    expect(found?.cursor).toBe(700);
    expect(Object.keys(found!.pools).sort()).toEqual([POOL_A, POOL_B, POOL_NONE]);
    expect(found!.pools[POOL_A]).toEqual({ positions: [{ owner: OWNER, tickLower: -60, tickUpper: 60, salt: salt(1) }], truncated: false });
    expect(found!.pools[POOL_B]!.positions).toHaveLength(2);
    expect(found!.pools[POOL_NONE]).toEqual({ positions: [], truncated: false });
  });

  it("truncates a pool over the per-pool limit, and the pools past the total", async () => {
    await setCursor(700);
    for (let n = 1; n <= 3; n++) await put("mainnet", POOL_A, n);
    for (let n = 4; n <= 5; n++) await put("mainnet", POOL_B, n);
    const perPool = await indexedPositionsFor(arcosDb(), "mainnet", [POOL_A, POOL_B], 2);
    expect(perPool!.pools[POOL_A]).toMatchObject({ truncated: true });
    expect(perPool!.pools[POOL_B]).toMatchObject({ truncated: false, positions: [{}, {}] });
    // A total of 4: pool A's three fit, pool B's two don't, and an empty pool after it still does.
    const capped = await indexedPositionsFor(arcosDb(), "mainnet", [POOL_A, POOL_B, POOL_NONE], 10, 4);
    expect(capped!.pools[POOL_A]!.positions).toHaveLength(3);
    expect(capped!.pools[POOL_B]).toEqual({ positions: [], truncated: true });
    expect(capped!.pools[POOL_NONE]).toEqual({ positions: [], truncated: false });
  });
});
