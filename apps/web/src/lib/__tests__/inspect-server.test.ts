import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtraPool, InspectInput, Report, V4PositionIndex } from "@arcos/inspector";

// A marker module that throws outside a server build.
vi.mock("server-only", () => ({}));

// The index's answer, and the engine itself: these tests only check what cachedInspection hands the engine.
const { indexedExtrasFor, inspect } = vi.hoisted(() => ({
  indexedExtrasFor: vi.fn<(token: string) => Promise<{ extraPools: ExtraPool[]; v4Positions?: V4PositionIndex }>>(),
  inspect: vi.fn<(input: InspectInput) => Promise<Report>>(),
}));
vi.mock("../indexed-pools-server", () => ({ indexedExtrasFor }));
vi.mock("@arcos/inspector", async (original) => ({ ...(await original<typeof import("@arcos/inspector")>()), inspect }));

import { cachedInspection } from "../inspect-server";

const KEY = {
  currency0: "0x0000000000000000000000000000000000000000",
  currency1: "0x470f09ae20163d5e243f6530fb328912a8fcb099",
  fee: 10_000,
  tickSpacing: 200,
  hooks: "0x83139c02ee291298baef473a775c2e996c066044",
} as const;

describe("cachedInspection", () => {
  it("hands the engine the index's pools for the token, hooked ones included", async () => {
    indexedExtrasFor.mockResolvedValue({ extraPools: [{ version: "v4", key: KEY }] });
    inspect.mockResolvedValue({ degraded: false } as Report);
    await cachedInspection("0x0000000000000000000000000000000000a6a6a1");
    expect(indexedExtrasFor).toHaveBeenCalledWith("0x0000000000000000000000000000000000a6a6a1");
    expect(inspect.mock.calls[0]![0].extraPools).toEqual([{ version: "v4", key: KEY }]);
    expect(inspect.mock.calls[0]![0]).not.toHaveProperty("v4Positions");
  });

  it("hands the engine the index's positions for the token's v4 pools when it has them", async () => {
    const v4Positions: V4PositionIndex = { cursor: 32_000_000, pools: { [`0x${"9e".repeat(32)}`]: { positions: [], truncated: false } } };
    indexedExtrasFor.mockResolvedValue({ extraPools: [{ version: "v4", key: KEY }], v4Positions });
    inspect.mockResolvedValue({ degraded: false } as Report);
    await cachedInspection("0x0000000000000000000000000000000000a6a6a3");
    expect(inspect.mock.calls.at(-1)![0].v4Positions).toEqual(v4Positions);
  });

  it("inspects without extra pools when the index has none to give", async () => {
    indexedExtrasFor.mockResolvedValue({ extraPools: [] });
    inspect.mockResolvedValue({ degraded: false } as Report);
    await cachedInspection("0x0000000000000000000000000000000000a6a6a2");
    expect(inspect.mock.calls.at(-1)![0].extraPools).toBeUndefined();
  });
});

describe("cachedInspection off Arc", () => {
  const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  let n = 0;
  /** A fresh address per case: the report cache is one per process, for every case in this file. */
  const fresh = () => `0x00000000000000000000000000000000000b${(++n).toString(16).padStart(4, "0")}` as `0x${string}`;

  afterEach(() => vi.unstubAllEnvs());

  it("refuses a chain the flag doesn't switch on, and every chain on the testnet site, inspecting nothing", async () => {
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
    inspect.mockClear();
    await expect(cachedInspection(fresh(), "base")).rejects.toMatchObject({ name: "ChainNotEnabled" });
    vi.stubEnv("NEXT_PUBLIC_INSPECT_CHAINS", "base");
    await expect(cachedInspection(fresh(), "ethereum")).rejects.toMatchObject({ name: "ChainNotEnabled" });
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "testnet");
    await expect(cachedInspection(fresh(), "base")).rejects.toMatchObject({ name: "ChainNotEnabled" });
    expect(inspect).not.toHaveBeenCalled();
  });

  it("inspects on the chain with its registry entry, asks Sourcify, and never reads the Arc index", async () => {
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
    vi.stubEnv("NEXT_PUBLIC_INSPECT_CHAINS", "base");
    vi.stubEnv("BLOCKSCOUT_API_KEY", "proapi_test");
    indexedExtrasFor.mockClear();
    inspect.mockResolvedValue({ degraded: false } as Report);
    const token = fresh();
    await cachedInspection(token, "base");
    const input = inspect.mock.calls.at(-1)![0];
    expect(input).toMatchObject({ address: token, network: "mainnet", chain: { key: "base", chainId: 8453 }, explorerBase: "https://base.blockscout.com", unverifiedFails: false });
    expect(input.verifyFallback).toBeTruthy();
    expect(input.explorer).not.toBeNull();
    expect(input.explorerSkipped).toBeUndefined();
    expect(input.deadlineAt).toBeGreaterThan(Date.now());
    expect(indexedExtrasFor).not.toHaveBeenCalled();
    expect(input.extraPools).toBeUndefined();
  });

  it("keeps Arc's report and Base's of the same address apart", async () => {
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
    vi.stubEnv("NEXT_PUBLIC_INSPECT_CHAINS", "base");
    indexedExtrasFor.mockResolvedValue({ extraPools: [] });
    inspect.mockResolvedValue({ degraded: false } as Report);
    inspect.mockClear();
    await cachedInspection(BASE_USDC, "base");
    await cachedInspection(BASE_USDC, "arc");
    await cachedInspection(BASE_USDC.toLowerCase() as `0x${string}`, "base");
    expect(inspect.mock.calls.map((c) => c[0].chain.key)).toEqual(["base", "arc"]);
  });

  it("leaves the explorer out, saying why, without a PRO key or once today's budget is spent", async () => {
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
    vi.stubEnv("NEXT_PUBLIC_INSPECT_CHAINS", "base");
    inspect.mockResolvedValue({ degraded: false } as Report);
    vi.stubEnv("BLOCKSCOUT_API_KEY", "none");
    await cachedInspection(fresh(), "base");
    expect(inspect.mock.calls.at(-1)![0]).toMatchObject({ explorer: null, explorerSkipped: "The explorer wasn't asked: this server has no key for it." });
    vi.stubEnv("BLOCKSCOUT_API_KEY", "proapi_test");
    vi.stubEnv("INSPECT_EXPLORER_DAILY_BUDGET", "0");
    await cachedInspection(fresh(), "base");
    expect(inspect.mock.calls.at(-1)![0]).toMatchObject({
      explorer: null,
      explorerSkipped: "The explorer wasn't asked: this server has used up today's explorer reads for chains other than Arc.",
    });
  });
});
