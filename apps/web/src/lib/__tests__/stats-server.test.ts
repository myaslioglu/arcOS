import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatsDoc, TimestampLike } from "@arcos/data";

// The real module is server-only and opens Firestore; here the database is a token and the read a stub.
vi.mock("server-only", () => ({}));
const { DB, arcosDb, readStats } = vi.hoisted(() => {
  const DB = { name: "arcos" };
  return { DB, arcosDb: vi.fn(() => DB), readStats: vi.fn() };
});
vi.mock("@arcos/data/server", () => ({ arcosDb, readStats }));

import { statsNumbers } from "../stats-server";

const at = (ms: number): TimestampLike => ({ seconds: Math.floor(ms / 1000), nanoseconds: 0, toDate: () => new Date(ms), toMillis: () => ms });
const T0 = 1_790_000_000_000;
const doc = (): Partial<StatsDoc> => ({
  block: 100,
  head: 100,
  totals: {
    tokensCreated: 4,
    byTemplate: { standard: 4, mintable: 0, burnable: 0, mintableBurnable: 0 },
    drops: 0, dropsNative: 0, dropsToken: 0, rowsSubmitted: 0, rowsDelivered: 0, rowsFailed: 0, feesMint: "0", feesDrop: "0",
  },
  onchainSince: at(T0),
  updatedAt: at(T0),
  server: null,
});

describe("statsNumbers", () => {
  beforeEach(() => {
    // One reader per process (process-global.ts): each test starts with a fresh one, so no cache or cooldown carries over.
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("arcos.index.stats")];
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
    vi.stubEnv("K_SERVICE", undefined);
    vi.stubEnv("FIRESTORE_EMULATOR_HOST", undefined);
    arcosDb.mockClear();
    readStats.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("reads nothing on a server that isn't App Hosting or the emulator, and says so", async () => {
    await expect(statsNumbers()).rejects.toMatchObject({ name: "IndexUnavailable", message: "This server doesn't read the usage counts." });
    expect(arcosDb).not.toHaveBeenCalled();
    expect(readStats).not.toHaveBeenCalled();
  });

  it("reads nothing on testnet, even on App Hosting", async () => {
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "testnet");
    vi.stubEnv("K_SERVICE", "arcos-testnet");
    await expect(statsNumbers()).rejects.toMatchObject({ name: "IndexUnavailable" });
    expect(readStats).not.toHaveBeenCalled();
  });

  it("reads stats/mainnet from the arcos database on App Hosting and answers the public counts, once a minute", async () => {
    vi.stubEnv("K_SERVICE", "arcos");
    readStats.mockResolvedValue(doc());
    const first = await statsNumbers();
    await statsNumbers();
    expect(readStats).toHaveBeenCalledTimes(1);
    expect(readStats).toHaveBeenCalledWith(DB, "mainnet");
    expect(first.counts.find((c) => c.id === "tokens_created")?.value).toBe(4);
    expect(first.asOf?.block).toBe(100);
  });

  it("answers no counts before the indexer has counted anything", async () => {
    vi.stubEnv("K_SERVICE", "arcos");
    readStats.mockResolvedValue(null);
    expect(await statsNumbers()).toMatchObject({ asOf: null, counts: [] });
  });

  it("rejects with IndexUnavailable when the read fails, carrying the cause, and stays down for a minute", async () => {
    vi.stubEnv("K_SERVICE", "arcos");
    readStats.mockRejectedValue(Object.assign(new Error("boom"), { code: 7 }));
    await expect(statsNumbers()).rejects.toMatchObject({ name: "IndexUnavailable", cause: { code: 7 } });
    await expect(statsNumbers()).rejects.toMatchObject({ name: "IndexUnavailable", message: "The usage counts can't be read right now." });
    expect(readStats).toHaveBeenCalledTimes(1);
  });
});
