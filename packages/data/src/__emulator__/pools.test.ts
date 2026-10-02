import { deleteApp, getApps } from "firebase-admin/app";
import { afterAll, describe, expect, it } from "vitest";
import { COLLECTIONS, poolId, poolToDoc, v4PoolKeys, type PoolRecord } from "../index";
import { arcosDb, indexedPools } from "../server";

afterAll(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

const TOKEN = "0x00000000000000000000000000000000000a6a01";
const OTHER = "0x00000000000000000000000000000000000a6a02";
const ZERO = "0x0000000000000000000000000000000000000000";

const pool = (over: Partial<PoolRecord>): PoolRecord => ({
  network: "mainnet",
  poolId: "0x00000000000000000000000000000000000b0001",
  version: "v3",
  token: TOKEN,
  quote: "USDC",
  fee: 3000,
  createdBlock: 1,
  key: null,
  depthUsdc: null,
  sampledAt: null,
  ...over,
});

async function put(record: PoolRecord): Promise<void> {
  await arcosDb().collection(COLLECTIONS.pools).doc(poolId(record.network, record.poolId)).set(poolToDoc(record));
}

describe("indexedPools", () => {
  it("returns the token's pools on the network asked, with the v4 keys the Inspector reads, and nothing else", async () => {
    const v4Key = { currency0: ZERO, currency1: TOKEN, fee: 10_000, tickSpacing: 200, hooks: "0x00000000000000000000000000000000000c0c0c" } as const;
    await put(pool({}));
    await put(pool({ poolId: `0x${"a6".repeat(32)}`, version: "v4", quote: "USDC-native", fee: 10_000, key: v4Key }));
    await put(pool({ poolId: "0x00000000000000000000000000000000000b0002", token: OTHER }));
    await put(pool({ poolId: "0x00000000000000000000000000000000000b0003", network: "testnet" }));

    const found = await indexedPools(arcosDb(), "mainnet", TOKEN.toUpperCase().replace("0X", "0x"));
    expect(found.map((p) => p.poolId).sort()).toEqual(["0x00000000000000000000000000000000000b0001", `0x${"a6".repeat(32)}`]);
    expect(v4PoolKeys(found)).toEqual([v4Key]);
  });

  it("stops at the limit, and finds nothing for a token without pools", async () => {
    for (let i = 0; i < 3; i++) await put(pool({ poolId: `0x00000000000000000000000000000000000b01${i.toString().padStart(2, "0")}`, token: OTHER }));
    expect(await indexedPools(arcosDb(), "mainnet", OTHER, 2)).toHaveLength(2);
    expect(await indexedPools(arcosDb(), "mainnet", "0x00000000000000000000000000000000000a6aff")).toEqual([]);
  });
});
