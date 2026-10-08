import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TimestampLike } from "@arcos/data";

// The real module is server-only and opens Firestore; here the database is a token and the read a stub, so this file
// checks what radarFeedPage asks it, when, and what it logs.
vi.mock("server-only", () => ({}));
const { DB, arcosDb, readRadarFeed } = vi.hoisted(() => {
  const DB = { name: "arcos" };
  return { DB, arcosDb: vi.fn(() => DB), readRadarFeed: vi.fn() };
});
vi.mock("@arcos/data/server", () => ({ arcosDb, readRadarFeed }));

import { IndexUnavailable } from "../index-source";
import { radarFeedPage } from "../radar-server";

const T0 = 1_790_000_000_000;
const at = (millis: number): TimestampLike => ({
  seconds: Math.floor(millis / 1000),
  nanoseconds: (millis % 1000) * 1_000_000,
  toDate: () => new Date(millis),
  toMillis: () => millis,
});
const row = (over: Record<string, unknown> = {}) => ({
  address: "0x470f09ae20163d5e243f6530fb328912a8fcb099",
  symbol: "RDR",
  name: "Radar token",
  source: "v3",
  firstSeen: at(T0),
  passed: 6,
  total: 9,
  bestPoolDepth: "2500000000",
  decimals: 18,
  creator: null,
  ...over,
});
const feed = (rows: unknown[]) => ({ feed: { rows }, indexer: { lastRunAt: at(T0 + 60_000) } });

describe("radarFeedPage", () => {
  beforeEach(() => {
    // One reader per process (process-global.ts): each test starts with a fresh one, so no cache or cooldown carries over.
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("arcos.index.radar")];
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
    vi.stubEnv("K_SERVICE", undefined);
    vi.stubEnv("FIRESTORE_EMULATOR_HOST", undefined);
    arcosDb.mockClear();
    readRadarFeed.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("reads nothing on a server that isn't App Hosting or the emulator, and says so", async () => {
    await expect(radarFeedPage("all")).rejects.toMatchObject({ name: "IndexUnavailable", message: "This server doesn't read the token index." });
    expect(arcosDb).not.toHaveBeenCalled();
    expect(readRadarFeed).not.toHaveBeenCalled();
  });

  it("reads the filter's feed from the arcos database on App Hosting", async () => {
    vi.stubEnv("K_SERVICE", "arcos");
    readRadarFeed.mockResolvedValue(feed([row()]));
    const page = await radarFeedPage("liquid");
    expect(readRadarFeed).toHaveBeenCalledTimes(1);
    expect(readRadarFeed).toHaveBeenCalledWith(DB, "mainnet", "liquid");
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]?.address).toBe("0x470f09ae20163d5e243f6530fb328912a8fcb099");
    expect(page.indexedAt).toBe(new Date(T0 + 60_000).toISOString());
    expect(page.skipped).toBe(0);
  });

  it("logs how many stored rows it skipped, as a count and nothing else", async () => {
    vi.stubEnv("K_SERVICE", "arcos");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    readRadarFeed.mockResolvedValue(feed([row(), row({ address: "0x12", symbol: "SECRET-row" })]));
    const page = await radarFeedPage("all");
    expect(page.rows).toHaveLength(1);
    expect(page.skipped).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("radar rows skipped", 1);
    expect(warn.mock.calls[0]).toHaveLength(2);
    warn.mockRestore();
  });

  it("logs nothing when every stored row is good", async () => {
    vi.stubEnv("K_SERVICE", "arcos");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    readRadarFeed.mockResolvedValue(feed([row()]));
    await radarFeedPage("all");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("reads a filter once within the TTL", async () => {
    vi.stubEnv("K_SERVICE", "arcos");
    readRadarFeed.mockResolvedValue(feed([row()]));
    const first = await radarFeedPage("passing");
    const second = await radarFeedPage("passing");
    expect(readRadarFeed).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("names the token index when the read fails, keeping the read's error as the cause", async () => {
    vi.stubEnv("K_SERVICE", "arcos");
    const denied = Object.assign(new Error("7 PERMISSION_DENIED: projects/demo-x/databases/arcos"), { code: 7 });
    readRadarFeed.mockRejectedValue(denied);
    const failure = await radarFeedPage("all").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(IndexUnavailable);
    expect((failure as Error).message).toBe("The token index can't be read right now.");
    expect((failure as Error).cause).toBe(denied);
  });
});
