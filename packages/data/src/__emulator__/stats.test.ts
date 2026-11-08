import { deleteApp, getApps } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COLLECTIONS, DataError, statsAnswer, statsDaysId, statsId, type StatsDoc } from "../index";
import { arcosDb, readStats } from "../server";

const NETWORKS = ["mainnet", "testnet"] as const;

// The emulator keeps what other suites wrote; this one starts from no stats doc on either network.
beforeAll(async () => {
  const db = arcosDb();
  for (const network of NETWORKS) await db.collection(COLLECTIONS.stats).doc(statsId(network)).delete();
});

afterAll(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

const AT = 1_790_000_000_000;

const stats = (over: Partial<StatsDoc> = {}): StatsDoc => ({
  network: "mainnet",
  block: 24_000_000,
  fromBlock: 22_742_796,
  head: 24_000_050,
  fees: { mintFlat: "1000000000000000000", dropPerRecipient: null, dropMin: null },
  totals: {
    tokensCreated: 3,
    byTemplate: { standard: 2, mintable: 1, burnable: 0, mintableBurnable: 0 },
    drops: 2,
    dropsNative: 1,
    dropsToken: 1,
    rowsSubmitted: 10,
    rowsDelivered: 9,
    rowsFailed: 1,
    feesMint: "3000000000000000000",
    feesDrop: "4000000000000000000",
  },
  excluded: { tokensCreated: 1, drops: 1 },
  server: null,
  onchainSince: Timestamp.fromMillis(Date.parse("2026-09-25T00:00:00Z")),
  updatedAt: Timestamp.fromMillis(AT),
  ...over,
});

describe("readStats", () => {
  it("is null before the indexer has counted anything, on either network", async () => {
    for (const network of NETWORKS) expect(await readStats(arcosDb(), network)).toBeNull();
    expect(statsAnswer(null).counts).toEqual([]);
  });

  it("reads the doc of the network asked, with its Timestamps and amounts as stored", async () => {
    await arcosDb().collection(COLLECTIONS.stats).doc(statsId("mainnet")).set(stats());
    const doc = await readStats(arcosDb(), "mainnet");
    expect(doc?.block).toBe(24_000_000);
    expect(doc?.totals.feesMint).toBe("3000000000000000000");
    expect(doc?.updatedAt.toMillis()).toBe(AT);
    expect(await readStats(arcosDb(), "testnet")).toBeNull();
  });

  it("makes the public answer from what it read, with no fee total", async () => {
    const doc = await readStats(arcosDb(), "mainnet");
    const answer = statsAnswer(doc);
    expect(answer.asOf).toEqual({ block: 24_000_000, at: new Date(AT).toISOString(), behind: 50 });
    expect(answer.counts.find((c) => c.id === "tokens_created")?.value).toBe(3);
    expect(JSON.stringify(answer)).not.toMatch(/fee/i);
  });

  it("refuses a network that isn't one, and a day-buckets month that isn't one", async () => {
    await expect(readStats(arcosDb(), "devnet" as never)).rejects.toBeInstanceOf(DataError);
    expect(() => statsDaysId("mainnet", "2026-10-01")).toThrow(DataError);
  });
});
