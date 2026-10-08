import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RadarPage } from "@/lib/radar";

// The real module is server-only and opens Firestore; the route only needs its page.
const { radarFeedPage } = vi.hoisted(() => ({ radarFeedPage: vi.fn<(filter: string) => Promise<RadarPage>>() }));
vi.mock("@/lib/radar-server", () => ({ radarFeedPage }));

import { GET } from "@/app/api/radar/route";
import { IndexUnavailable } from "@/lib/index-source";
import { BEFORE_ERROR, LIQUIDITY_ERROR, PASSED_ERROR } from "@/lib/radar";

const TOKEN = "0x470f09ae20163d5e243f6530fb328912a8fcb099";
const page: RadarPage = {
  rows: [
    {
      address: TOKEN, symbol: "RDR", name: "Radar token", source: "v3", firstSeen: "2026-10-08T11:58:00.000Z", passed: 6, total: 9,
      bestPoolDepth: "2500000000", decimals: 18, launchpad: null,
    },
  ],
  indexedAt: "2026-10-08T12:00:00.000Z",
  skipped: 0,
};

let ip = 0;
const get = (query = "") => GET(new Request(`https://4rcos.test/api/radar${query}`, { headers: { "x-forwarded-for": `198.51.100.${++ip % 250}` } }));

describe("GET /api/radar", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
    radarFeedPage.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("is not there on testnet, which has no index", async () => {
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "testnet");
    const res = await get();
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "Not available on this network." });
    expect(radarFeedPage).not.toHaveBeenCalled();
  });

  it("refuses a page cursor and any value but the two each filter takes, without reading the index", async () => {
    for (const [query, error] of [
      ["?before=2026-01-01T00:00:00Z", BEFORE_ERROR],
      ["?minPassed=3", PASSED_ERROR],
      ["?hasLiquidity=true", LIQUIDITY_ERROR],
    ] as const) {
      const res = await get(query);
      expect(res.status, query).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ error });
    }
    expect(radarFeedPage).not.toHaveBeenCalled();
  });

  it("asks for the feed each filter combination names", async () => {
    radarFeedPage.mockResolvedValue({ rows: [], indexedAt: null, skipped: 0 });
    for (const [query, filter] of [
      ["", "all"],
      ["?hasLiquidity=1", "liquid"],
      ["?minPassed=5", "passing"],
      ["?hasLiquidity=1&minPassed=5", "liquid-passing"],
      ["?hasLiquidity=0&minPassed=0", "all"],
    ] as const) {
      radarFeedPage.mockClear();
      expect((await get(query)).status, query).toBe(200);
      expect(radarFeedPage, query).toHaveBeenCalledWith(filter);
    }
  });

  it("answers the page's rows and the index's last run, kept 20 s at the CDN, and never the skipped count", async () => {
    radarFeedPage.mockResolvedValue(page);
    const res = await get("?hasLiquidity=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=20");
    expect(await res.json()).toEqual({ rows: page.rows, indexedAt: page.indexedAt });
  });

  it("answers an empty page with a 200", async () => {
    radarFeedPage.mockResolvedValue({ rows: [], indexedAt: null, skipped: 0 });
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rows: [], indexedAt: null });
  });

  it("limits each client to 60 requests a minute", async () => {
    radarFeedPage.mockResolvedValue({ rows: [], indexedAt: null, skipped: 0 });
    const req = () => GET(new Request("https://4rcos.test/api/radar", { headers: { "x-forwarded-for": "203.0.113.9" } }));
    for (let i = 0; i < 60; i++) expect((await req()).status).toBe(200);
    const res = await req();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(radarFeedPage).toHaveBeenCalledTimes(60);
  });

  it("answers 503, uncached, when the index can't be read, logging the error's name and its gRPC code only", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    radarFeedPage.mockRejectedValue(new IndexUnavailable(undefined, { cause: { code: 7, message: "projects/demo-x/databases/arcos" } }));
    const res = await get();
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("retry-after")).toBe("60");
    expect(await res.json()).toEqual({ error: "The token index can't be read right now." });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("radar failed", "IndexUnavailable", 7);
    for (const arg of log.mock.calls.flat()) {
      expect(String(arg)).not.toContain("demo-");
      expect(String(arg)).not.toContain("databases");
    }

    log.mockClear();
    radarFeedPage.mockRejectedValue(new IndexUnavailable("This server doesn't read the token index."));
    expect((await get()).status).toBe(503);
    expect(log).toHaveBeenCalledWith("radar failed", "IndexUnavailable");
    expect(log.mock.calls.flat().some((v) => String(v).includes("doesn't read"))).toBe(false);
    log.mockRestore();
  });
});
