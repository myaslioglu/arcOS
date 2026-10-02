import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolDoc } from "@arcos/data";

// The real module is server-only and opens Firestore; the route only needs its answer.
const { indexedPools } = vi.hoisted(() => ({ indexedPools: vi.fn<(token: string) => Promise<PoolDoc[]>>() }));
vi.mock("@/lib/indexed-pools-server", () => ({ indexedPools }));

import { GET } from "@/app/api/pools/[token]/route";

const TOKEN = "0x470f09ae20163d5e243f6530fb328912a8fcb099";
const KEY = { currency0: "0x0000000000000000000000000000000000000000", currency1: TOKEN, fee: 10_000, tickSpacing: 200, hooks: "0x83139c02ee291298baef473a775c2e996c066044" } as const;
const pool: PoolDoc = {
  network: "mainnet", poolId: `0x${"9e".repeat(32)}`, version: "v4", token: TOKEN, quote: "USDC-native", fee: 10_000, createdBlock: 7, key: KEY,
  depthUsdc: null, sampledAt: null,
};

let ip = 0;
const get = (token: string) =>
  GET(new Request(`https://4rcos.test/api/pools/${token}`, { headers: { "x-forwarded-for": `198.51.100.${++ip % 250}` } }), {
    params: Promise.resolve({ token }),
  });

describe("GET /api/pools/[token]", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
    indexedPools.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("answers the token's indexed pools, v4 keys included, kept a minute at the CDN", async () => {
    indexedPools.mockResolvedValue([pool]);
    const res = await get(TOKEN);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=60");
    expect(await res.json()).toEqual({
      pools: [{ id: pool.poolId, version: "v4", quote: "USDC-native", fee: 10_000, createdBlock: 7, key: KEY, depthUsdc: null }],
    });
    expect(indexedPools).toHaveBeenCalledWith(TOKEN);
  });

  it("refuses what isn't an address, without reading the index", async () => {
    const res = await get("0x12");
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(indexedPools).not.toHaveBeenCalled();
  });

  it("is not there on testnet, which has no index", async () => {
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "testnet");
    const res = await get(TOKEN);
    expect(res.status).toBe(404);
    expect(indexedPools).not.toHaveBeenCalled();
  });

  it("answers 503, uncached, when the index can't be read, and logs the error's name only", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    indexedPools.mockRejectedValue(Object.assign(new Error("projects/arcos-c80cf/databases/arcos PERMISSION_DENIED"), { name: "IndexUnavailable" }));
    const res = await get(TOKEN);
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(log).toHaveBeenCalledWith("pools failed", "IndexUnavailable");
    log.mockRestore();
  });

  it("limits each client to 30 requests a minute", async () => {
    indexedPools.mockResolvedValue([]);
    const req = () => GET(new Request(`https://4rcos.test/api/pools/${TOKEN}`, { headers: { "x-forwarded-for": "203.0.113.9" } }), { params: Promise.resolve({ token: TOKEN }) });
    for (let i = 0; i < 30; i++) expect((await req()).status).toBe(200);
    expect((await req()).status).toBe(429);
  });
});
