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
  for (const name of [COLLECTIONS.positions, COLLECTIONS.positionsIndex, COLLECTIONS.indexer]) {
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
    await setCursor(500);
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
    // Pool A is over its limit, so its list is left out, and nothing after it is read: pool B is "truncated" unread.
    expect(perPool!.pools[POOL_A]).toEqual({ positions: [], truncated: true });
    expect(perPool!.pools[POOL_B]).toEqual({ positions: [], truncated: true });
    expect((await indexedPositionsFor(arcosDb(), "mainnet", [POOL_B, POOL_A], 2))!.pools[POOL_B]).toMatchObject({ truncated: false, positions: [{}, {}] });
    // A total of 4: pool A's three fit, pool B's two don't, and the pool after it isn't read at all.
    const capped = await indexedPositionsFor(arcosDb(), "mainnet", [POOL_A, POOL_B, POOL_NONE], 10, 4);
    expect(capped!.pools[POOL_A]!.positions).toHaveLength(3);
    expect(capped!.pools[POOL_B]).toEqual({ positions: [], truncated: true });
    expect(capped!.pools[POOL_NONE]).toEqual({ positions: [], truncated: true });
    // Exactly the total: every pool up to it is whole, and the ones after it are unread.
    const exact = await indexedPositionsFor(arcosDb(), "mainnet", [POOL_A, POOL_B, POOL_NONE], 10, 5);
    expect(exact!.pools[POOL_B]!.positions).toHaveLength(2);
    expect(exact!.pools[POOL_NONE]).toEqual({ positions: [], truncated: true });
  });

  it("reads no more than the total plus one a pool, however many positions the pools hold", async () => {
    await setCursor(700);
    for (let n = 1; n <= 6; n++) await put("mainnet", POOL_A, n);
    for (let n = 7; n <= 12; n++) await put("mainnet", POOL_B, n);
    const db = arcosDb();
    const limits: number[] = [];
    const counting = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "collection") return Reflect.get(target, prop, receiver) as unknown;
        return (name: string) => {
          const collection = target.collection(name);
          return new Proxy(collection, {
            get(c, p, r) {
              if (p !== "where") return Reflect.get(c, p, r) as unknown;
              return (...args: Parameters<typeof collection.where>) => {
                const query = c.where(...args);
                const second = query.where.bind(query);
                query.where = ((...more: Parameters<typeof query.where>) => {
                  const q = second(...more);
                  const limit = q.limit.bind(q);
                  q.limit = (n: number) => (limits.push(n), limit(n));
                  return q;
                }) as typeof query.where;
                return query;
              };
            },
          });
        };
      },
    });
    const got = await indexedPositionsFor(counting, "mainnet", [POOL_A, POOL_B, POOL_NONE], 500, 8);
    // Pool A: at most 8 (+1). Pool B: the 2 left (+1), and it has more. Pool C: not asked.
    expect(limits).toEqual([9, 3]);
    expect(got!.pools[POOL_A]!.positions).toHaveLength(6);
    expect(got!.pools[POOL_B]).toEqual({ positions: [], truncated: true });
    expect(got!.pools[POOL_NONE]).toEqual({ positions: [], truncated: true });
  });
});

describe("the positions switch", () => {
  const controls = (positions?: boolean) =>
    arcosDb().collection(COLLECTIONS.indexer).doc("mainnet").set({ network: "mainnet", block: 1, ...(positions === undefined ? {} : { positions }) });

  it("serves nothing while indexer/{network}.positions is false, at once, whatever the cursor says", async () => {
    await setCursor(700);
    await put("mainnet", POOL_A, 1);
    await controls(false);
    expect(await readPositionsCursor(arcosDb(), "mainnet")).toBeNull();
    expect(await indexedPositionsFor(arcosDb(), "mainnet", [POOL_A])).toBeNull();
    expect(await indexedPositions(arcosDb(), "mainnet", POOL_A)).toEqual({ positions: [], truncated: false, cursor: null });
  });

  it("serves again when the switch is true, missing, or there is no controls doc", async () => {
    await setCursor(700);
    await put("mainnet", POOL_A, 1);
    for (const value of [true, undefined]) {
      await controls(value);
      expect((await indexedPositionsFor(arcosDb(), "mainnet", [POOL_A]))?.pools[POOL_A]?.positions).toHaveLength(1);
    }
    await arcosDb().collection(COLLECTIONS.indexer).doc("mainnet").delete();
    expect(await readPositionsCursor(arcosDb(), "mainnet")).toBe(700);
  });
});
