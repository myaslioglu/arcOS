import { deleteApp, getApps } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COLLECTIONS, DataError, radarFeedId, type IndexerDoc, type RadarFeedDoc, type RadarRow } from "../index";
import { arcosDb, readRadarFeed } from "../server";

const NETWORKS = ["mainnet", "testnet"] as const;
const FILTERS = ["all", "liquid", "passing", "liquid-passing"] as const;

// The emulator keeps what other suites wrote; this one starts from no feed and no indexer doc on either network.
beforeAll(async () => {
  const db = arcosDb();
  for (const network of NETWORKS) {
    await db.collection(COLLECTIONS.indexer).doc(network).delete();
    for (const filter of FILTERS) await db.collection(COLLECTIONS.radarFeed).doc(radarFeedId(network, filter)).delete();
  }
});

afterAll(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

const TOKEN = "0x00000000000000000000000000000000000ada01";
const RUN_AT = 1_790_000_000_000;

const row = (over: Partial<RadarRow> = {}): RadarRow => ({
  address: TOKEN,
  symbol: "RDR",
  name: "Radar token",
  source: "factory",
  firstSeen: Timestamp.fromMillis(RUN_AT - 60_000),
  passed: 6,
  total: 9,
  bestPoolDepth: "2500000000",
  decimals: 18,
  creator: "0x00000000000000000000000000000000000c0ffe",
  ...over,
});

async function seedFeed(network: "mainnet" | "testnet", filter: "all" | "liquid" | "passing" | "liquid-passing", rows: RadarRow[]) {
  const doc: RadarFeedDoc = { network, filter, rows, updatedAt: Timestamp.fromMillis(RUN_AT) };
  await arcosDb().collection(COLLECTIONS.radarFeed).doc(radarFeedId(network, filter)).set(doc);
}

async function seedIndexer(network: "mainnet" | "testnet", lastRunAt: number | null) {
  const doc: IndexerDoc = {
    network,
    block: 100,
    updatedAt: Timestamp.fromMillis(RUN_AT),
    lastRunAt: lastRunAt === null ? null : Timestamp.fromMillis(lastRunAt),
    paused: false,
    inspect: true,
    halted: null,
    explorerCalls: { day: "2026-10-08", count: 0 },
    runningUntil: null,
    runId: null,
  };
  await arcosDb().collection(COLLECTIONS.indexer).doc(network).set(doc);
}

describe("readRadarFeed", () => {
  it("answers nulls before the indexer has written anything", async () => {
    expect(await readRadarFeed(arcosDb(), "mainnet", "liquid-passing")).toEqual({ feed: null, indexer: null });
  });

  it("returns the feed's rows and the indexer's last run, and nothing else of the indexer doc", async () => {
    await seedFeed("mainnet", "all", [row()]);
    await seedIndexer("mainnet", RUN_AT);
    const read = await readRadarFeed(arcosDb(), "mainnet", "all");
    expect(read.feed?.filter).toBe("all");
    expect(read.feed?.rows).toHaveLength(1);
    expect(read.feed?.rows[0]).toMatchObject({ address: TOKEN, symbol: "RDR", passed: 6, total: 9, decimals: 18, bestPoolDepth: "2500000000" });
    expect(read.feed?.rows[0]?.firstSeen.toMillis()).toBe(RUN_AT - 60_000);
    expect(read.indexer?.lastRunAt?.toMillis()).toBe(RUN_AT);
    expect(Object.keys(read.indexer ?? {})).toEqual(["lastRunAt"]);
  });

  it("reads each filter's own doc", async () => {
    await seedFeed("mainnet", "all", [row()]);
    await seedFeed("mainnet", "liquid", []);
    await seedIndexer("mainnet", RUN_AT);
    expect((await readRadarFeed(arcosDb(), "mainnet", "liquid")).feed?.rows).toEqual([]);
    expect((await readRadarFeed(arcosDb(), "mainnet", "passing")).feed).toBeNull();
  });

  it("never reads a testnet doc for mainnet", async () => {
    await seedFeed("testnet", "passing", [row()]);
    await seedIndexer("testnet", RUN_AT + 5_000);
    await seedIndexer("mainnet", RUN_AT);
    const read = await readRadarFeed(arcosDb(), "mainnet", "passing");
    expect(read.feed).toBeNull();
    expect(read.indexer?.lastRunAt?.toMillis()).toBe(RUN_AT);
    expect((await readRadarFeed(arcosDb(), "testnet", "passing")).feed?.rows).toHaveLength(1);
  });

  it("reads a null lastRunAt as null", async () => {
    await seedIndexer("mainnet", null);
    expect((await readRadarFeed(arcosDb(), "mainnet", "all")).indexer).toEqual({ lastRunAt: null });
  });

  it("refuses a filter that isn't one of the four, as a rejection", async () => {
    await expect(readRadarFeed(arcosDb(), "mainnet", "bogus" as never)).rejects.toMatchObject({ name: "DataError", code: "radar-filter" });
    await expect(readRadarFeed(arcosDb(), "mainnet", "bogus" as never)).rejects.toBeInstanceOf(DataError);
  });
});
