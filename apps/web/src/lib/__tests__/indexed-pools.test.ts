import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolDoc } from "@arcos/data";
import { IndexUnavailable, extraPoolsFrom, fetchExtraPools, indexEnabled, indexedPoolsSource, poolsAnswer } from "../indexed-pools";

const TOKEN = "0x470f09ae20163d5e243f6530fb328912a8fcb099";
const ZERO = "0x0000000000000000000000000000000000000000";
const HOOK = "0x83139c02ee291298baef473a775c2e996c066044";
const key = { currency0: ZERO, currency1: TOKEN, fee: 10_000, tickSpacing: 200, hooks: HOOK } as const;

const doc = (over: Partial<PoolDoc>): PoolDoc => ({
  network: "mainnet",
  poolId: "0x2982e0fed1815f130110b60c82339db9a4731677",
  version: "v3",
  token: TOKEN,
  quote: "USDC",
  fee: 3000,
  createdBlock: 100,
  key: null,
  depthUsdc: null,
  sampledAt: null,
  ...over,
});

describe("poolsAnswer", () => {
  it("answers each pool's id, version, quote, fee, block, key and depth, newest first, and nothing else", () => {
    const v4 = doc({ poolId: `0x${"9e".repeat(32)}`, version: "v4", quote: "USDC-native", fee: 10_000, createdBlock: 200, key, depthUsdc: "5" });
    expect(poolsAnswer([doc({}), v4])).toEqual({
      pools: [
        { id: `0x${"9e".repeat(32)}`, version: "v4", quote: "USDC-native", fee: 10_000, createdBlock: 200, key, depthUsdc: "5" },
        { id: "0x2982e0fed1815f130110b60c82339db9a4731677", version: "v3", quote: "USDC", fee: 3000, createdBlock: 100, key: null, depthUsdc: null },
      ],
    });
  });
});

describe("extraPoolsFrom", () => {
  it("takes the v4 keys, hooks included, and leaves the other versions to discovery", () => {
    expect(extraPoolsFrom(poolsAnswer([doc({}), doc({ version: "v4", key })]))).toEqual([{ version: "v4", key }]);
  });

  it("drops anything malformed: it came over the network", () => {
    const bad = [
      { version: "v4", key: { ...key, currency0: "nope" } },
      { version: "v4", key: { ...key, fee: -1 } },
      { version: "v4", key: { ...key, fee: 2 ** 24 } },
      { version: "v4", key: { ...key, tickSpacing: 0 } },
      { version: "v4", key: { ...key, hooks: 7 } },
      { version: "v4", key: null },
      { version: "v4" },
      "pool",
    ];
    expect(extraPoolsFrom({ pools: bad })).toEqual([]);
    expect(extraPoolsFrom(null)).toEqual([]);
    expect(extraPoolsFrom({ pools: "x" })).toEqual([]);
  });
});

describe("indexEnabled", () => {
  it("reads the index on mainnet only, and only on App Hosting or against the emulator", () => {
    expect(indexEnabled("mainnet", { K_SERVICE: "arcos" })).toBe(true);
    expect(indexEnabled("mainnet", { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8181" })).toBe(true);
    expect(indexEnabled("mainnet", {})).toBe(false);
    expect(indexEnabled("testnet", { K_SERVICE: "arcos-testnet" })).toBe(false);
  });
});

describe("indexedPoolsSource", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps an answer a minute per token, whatever the address's case", async () => {
    const load = vi.fn(async () => [doc({})]);
    let t = 0;
    const source = indexedPoolsSource({ load, now: () => t });
    await source.pools(TOKEN);
    await source.pools(TOKEN.toUpperCase().replace("0X", "0x"));
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(TOKEN);
    t = 60_001;
    await source.pools(TOKEN);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("gives up on a slow read after the deadline, then reads nothing for a minute", async () => {
    let t = 0;
    const load = vi.fn(() => new Promise<PoolDoc[]>(() => {}));
    const source = indexedPoolsSource({ load, now: () => t, deadlineMs: 1_500 });
    const slow = source.pools(TOKEN);
    const settled = expect(slow).rejects.toBeInstanceOf(IndexUnavailable);
    await vi.advanceTimersByTimeAsync(1_500);
    await settled;
    t = 1_500;
    await expect(source.pools("0x1111111111111111111111111111111111111111")).rejects.toBeInstanceOf(IndexUnavailable);
    expect(load).toHaveBeenCalledTimes(1);
    t = 61_501;
    load.mockResolvedValueOnce([]);
    await expect(source.pools(TOKEN)).resolves.toEqual([]);
  });

  it("never caches a failure as an answer", async () => {
    let t = 0;
    const load = vi.fn().mockRejectedValueOnce(new Error("PERMISSION_DENIED")).mockResolvedValue([doc({})]);
    const source = indexedPoolsSource({ load, now: () => t, cooldownMs: 10 });
    await expect(source.pools(TOKEN)).rejects.toMatchObject({ name: "IndexUnavailable", message: "The pool index can't be read right now." });
    t = 9;
    await expect(source.pools(TOKEN)).rejects.toMatchObject({ name: "IndexUnavailable", message: "The pool index can't be read right now." });
    t = 11;
    await expect(source.pools(TOKEN)).resolves.toHaveLength(1);
  });
});

describe("fetchExtraPools", () => {
  it("reads the route, and takes any failure as no indexed pools", async () => {
    const answer = poolsAnswer([doc({ version: "v4", key })]);
    const ok = vi.fn(async () => Response.json(answer)) as unknown as typeof fetch;
    expect(await fetchExtraPools(TOKEN, ok)).toEqual([{ version: "v4", key }]);
    expect((ok as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0]).toBe(`/api/pools/${TOKEN}`);

    const notFound = (async () => Response.json({ error: "x" }, { status: 404 })) as typeof fetch;
    expect(await fetchExtraPools(TOKEN, notFound)).toEqual([]);
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect(await fetchExtraPools(TOKEN, down)).toEqual([]);
  });
});
