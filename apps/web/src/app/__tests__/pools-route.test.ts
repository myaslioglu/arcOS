import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolDoc } from "@arcos/data";
import type { IndexedToken } from "@/lib/indexed-pools";

// The real module is server-only and opens Firestore; the route only needs its answer.
const { indexedToken } = vi.hoisted(() => ({ indexedToken: vi.fn<(token: string) => Promise<IndexedToken>>() }));
vi.mock("@/lib/indexed-pools-server", () => ({ indexedToken }));

import { GET } from "@/app/api/pools/[token]/route";
import { IndexUnavailable } from "@/lib/indexed-pools";

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
    indexedToken.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("answers the token's indexed pools, v4 keys included, kept a minute at the CDN", async () => {
    indexedToken.mockResolvedValue({ pools: [pool], positions: null });
    const res = await get(TOKEN);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=60");
    expect(await res.json()).toEqual({
      pools: [{ id: pool.poolId, version: "v4", quote: "USDC-native", fee: 10_000, createdBlock: 7, key: KEY, depthUsdc: null }],
    });
    expect(indexedToken).toHaveBeenCalledWith(TOKEN);
  });

  it("answers the positions the index holds for the token's v4 pools, under its cursor", async () => {
    const positions = {
      cursor: 32_211_901,
      pools: { [pool.poolId]: { positions: [{ owner: "0x6049c9a0e26405c0985f9e3685c87d0ae917f82b", tickLower: -887_250, tickUpper: 887_250, salt: `0x${"0".repeat(59)}51137` }], truncated: false } },
    } satisfies IndexedToken["positions"];
    indexedToken.mockResolvedValue({ pools: [pool], positions });
    const body = (await (await get(TOKEN)).json()) as { positions: unknown; pools: unknown[] };
    expect(body.positions).toEqual(positions);
    expect(body.pools).toHaveLength(1);
  });

  it("refuses what isn't an address, without reading the index", async () => {
    const res = await get("0x12");
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(indexedToken).not.toHaveBeenCalled();
  });

  it("is not there on testnet, which has no index", async () => {
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "testnet");
    const res = await get(TOKEN);
    expect(res.status).toBe(404);
    expect(indexedToken).not.toHaveBeenCalled();
  });

  it("answers 503, uncached, when the index can't be read, and logs the error's name only", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    indexedToken.mockRejectedValue(Object.assign(new Error("projects/arcos-c80cf/databases/arcos PERMISSION_DENIED"), { name: "IndexUnavailable" }));
    const res = await get(TOKEN);
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(log).toHaveBeenCalledWith("pools failed", "IndexUnavailable");
    log.mockRestore();
  });

  it("logs the read's own error code, a gRPC status, with the 503, and never its message", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const denied = Object.assign(new Error("7 PERMISSION_DENIED: Missing or insufficient permissions on projects/arcos-c80cf/databases/arcos"), { code: 7 });
    indexedToken.mockRejectedValue(new IndexUnavailable(undefined, { cause: denied }));
    expect((await get(TOKEN)).status).toBe(503);
    expect(log).toHaveBeenCalledWith("pools failed", "IndexUnavailable", 7);
    expect(log.mock.calls.flat().some((v) => String(v).includes("arcos-c80cf"))).toBe(false);
    log.mockRestore();
  });

  it("limits each client to 30 requests a minute", async () => {
    indexedToken.mockResolvedValue({ pools: [], positions: null });
    const req = () => GET(new Request(`https://4rcos.test/api/pools/${TOKEN}`, { headers: { "x-forwarded-for": "203.0.113.9" } }), { params: Promise.resolve({ token: TOKEN }) });
    for (let i = 0; i < 30; i++) expect((await req()).status).toBe(200);
    expect((await req()).status).toBe(429);
  });
});
