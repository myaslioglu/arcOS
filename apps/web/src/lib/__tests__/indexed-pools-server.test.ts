import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolDoc } from "@arcos/data";

// A marker module that throws outside a server build, and the Firestore layer: these tests drive the real sources with
// loads of their own.
vi.mock("server-only", () => ({}));
const { indexedPoolList, indexedPositionsFor } = vi.hoisted(() => ({ indexedPoolList: vi.fn(), indexedPositionsFor: vi.fn() }));
vi.mock("@arcos/data/server", () => ({ arcosDb: () => ({}), indexedPoolList, indexedPositionsFor }));

import { indexedExtrasFor, indexedToken } from "../indexed-pools-server";
import { indexedPoolsSource, indexedPositionsSource } from "../indexed-pools";

const TOKEN = "0x470f09ae20163d5e243f6530fb328912a8fcb099";
const POOL = `0x${"9e".repeat(32)}`;
const KEY = { currency0: "0x0000000000000000000000000000000000000000", currency1: TOKEN, fee: 10_000, tickSpacing: 200, hooks: "0x83139c02ee291298baef473a775c2e996c066044" } as const;
const pool = (over: Partial<PoolDoc> = {}): PoolDoc => ({
  network: "mainnet", poolId: POOL, version: "v4", token: TOKEN, quote: "USDC-native", fee: 10_000, createdBlock: 7, key: KEY, depthUsdc: null, sampledAt: null, ...over,
});

describe("indexedToken", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
    vi.stubEnv("K_SERVICE", "arcos");
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("answers the pools without positions when the positions are slow, and the next token is not held up by it", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const pools = indexedPoolsSource({ load: async () => ({ pools: [pool()], truncated: false }) });
    const positions = indexedPositionsSource({ deadlineMs: 300, load: async (token) => (token === "0xheavy" ? new Promise<never>(() => {}) : { cursor: 5, pools: {} }) });
    const heavy = indexedToken("0xheavy", { pools: pools.pools, positions: positions.positions });
    await vi.advanceTimersByTimeAsync(300);
    expect(await heavy).toEqual({ pools: [pool()], truncated: false, positions: null });
    // Straight after: the pools' cooldown was not armed, and neither token waits.
    expect(await indexedToken("0xother", { pools: pools.pools, positions: positions.positions })).toEqual({ pools: [pool()], truncated: false, positions: { cursor: 5, pools: {} } });
    expect(await indexedToken("0xthird", { pools: pools.pools, positions: positions.positions })).toMatchObject({ positions: { cursor: 5 } });
    expect(quiet).toHaveBeenCalledWith("positions failed", "IndexUnavailable");
    quiet.mockRestore();
  });

  it("rejects when the pools can't be read, and doesn't ask for positions then", async () => {
    const positions = vi.fn();
    await expect(indexedToken(TOKEN, { pools: async () => Promise.reject(new Error("down")), positions })).rejects.toThrow("down");
    expect(positions).not.toHaveBeenCalled();
  });

  it("doesn't read the index on testnet or off App Hosting", async () => {
    vi.stubEnv("K_SERVICE", "");
    await expect(indexedToken(TOKEN)).rejects.toMatchObject({ name: "IndexUnavailable" });
    expect(await indexedExtrasFor(TOKEN)).toEqual({ extraPools: [] });
  });
});

describe("the site's own sources", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
    vi.stubEnv("K_SERVICE", "arcos");
    indexedPoolList.mockReset();
    indexedPositionsFor.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("asks for the positions of the v4 pools the index lists for the token, and of no other pool", async () => {
    const A = "0x00000000000000000000000000000000000a6a61";
    indexedPoolList.mockResolvedValue({ pools: [pool(), pool({ poolId: "0x00000000000000000000000000000000000b0001", version: "v3", key: null })], truncated: true });
    indexedPositionsFor.mockResolvedValue({ cursor: 9, pools: { [POOL]: { positions: [], truncated: false } } });
    expect(await indexedExtrasFor(A)).toEqual({ extraPools: [{ version: "v4", key: KEY }], extraPoolsTruncated: true, v4Positions: { cursor: 9, pools: { [POOL]: { positions: [], truncated: false } } } });
    expect(indexedPositionsFor).toHaveBeenCalledWith(expect.anything(), "mainnet", [POOL]);
  });

  it("asks for none when the index lists no pool for the address: a random address costs one pools query", async () => {
    const B = "0x00000000000000000000000000000000000a6a62";
    indexedPoolList.mockResolvedValue({ pools: [], truncated: false });
    indexedPositionsFor.mockResolvedValue({ cursor: 9, pools: {} });
    await indexedExtrasFor(B);
    expect(indexedPositionsFor).toHaveBeenCalledWith(expect.anything(), "mainnet", []);
  });

  it("keeps the pools when the positions read fails, and leaves the positions out", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const C = "0x00000000000000000000000000000000000a6a63";
    indexedPoolList.mockResolvedValue({ pools: [pool()], truncated: false });
    indexedPositionsFor.mockRejectedValue(Object.assign(new Error("8 RESOURCE_EXHAUSTED"), { code: 8 }));
    expect(await indexedExtrasFor(C)).toEqual({ extraPools: [{ version: "v4", key: KEY }] });
    // The pools' source is not in a cooldown: another token is read at once.
    const D = "0x00000000000000000000000000000000000a6a64";
    indexedPositionsFor.mockResolvedValue({ cursor: 9, pools: {} });
    expect(await indexedExtrasFor(D)).toMatchObject({ v4Positions: { cursor: 9 } });
    quiet.mockRestore();
  });
});
