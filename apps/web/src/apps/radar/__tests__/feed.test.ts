import { describe, expect, it, vi } from "vitest";
import { RadarFetchError, fetchRadar, isGone, parseRadarAnswer, radarKey, radarQueryOptions, radarUrl } from "../feed";

const TOKEN = "0x470F09AE20163D5E243F6530FB328912A8FCB099";
const row = (over: Record<string, unknown> = {}) => ({
  address: TOKEN,
  symbol: "RDR",
  name: "Radar token",
  source: "v3",
  firstSeen: "2026-10-08T11:58:00.000Z",
  passed: 6,
  total: 9,
  bestPoolDepth: "2500000000",
  decimals: 18,
  launchpad: null,
  ...over,
});

describe("radarKey and radarUrl", () => {
  it("name the four feeds, and the route's query for each", () => {
    const cases = [
      [{ liquid: false, passing: false }, "all", "/api/radar"],
      [{ liquid: true, passing: false }, "liquid", "/api/radar?hasLiquidity=1"],
      [{ liquid: false, passing: true }, "passing", "/api/radar?minPassed=5"],
      [{ liquid: true, passing: true }, "liquid-passing", "/api/radar?hasLiquidity=1&minPassed=5"],
    ] as const;
    for (const [f, key, url] of cases) {
      expect(radarKey(f)).toBe(key);
      expect(radarUrl(f)).toBe(url);
    }
  });
});

describe("parseRadarAnswer", () => {
  it("throws on anything that isn't an answer", () => {
    for (const bad of [null, "x", [], {}, { rows: "x", indexedAt: null }, { rows: [], indexedAt: 5 }, { rows: [] }]) {
      expect(() => parseRadarAnswer(bad), JSON.stringify(bad)).toThrow(RadarFetchError);
    }
  });

  it("keeps a good row, lowercases its address, parses its time and cleans its labels", () => {
    const list = parseRadarAnswer({ rows: [row({ symbol: "RD‮R", name: " Radar \u0000token ", launchpad: "Pad​launch" })], indexedAt: "2026-10-08T12:00:00.000Z" });
    expect(list.rows).toEqual([
      {
        address: TOKEN.toLowerCase(), symbol: "RDR", name: "Radar token", source: "v3", firstSeen: "2026-10-08T11:58:00.000Z",
        firstSeenMs: Date.parse("2026-10-08T11:58:00.000Z"), passed: 6, total: 9, bestPoolDepth: "2500000000", decimals: 18, launchpad: "Padlaunch",
      },
    ]);
    expect(list.indexedAt).toBe(Date.parse("2026-10-08T12:00:00.000Z"));
  });

  it("drops a row with a bad address, source or time, and nulls a bad field", () => {
    const list = parseRadarAnswer({
      rows: [
        row({ address: "0x12" }),
        row({ source: "v5" }),
        row({ firstSeen: "yesterday" }),
        "junk",
        row({ passed: 6, total: null, bestPoolDepth: "01", decimals: 99, symbol: 5, name: null, launchpad: 7 }),
      ],
      indexedAt: null,
    });
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0]).toMatchObject({ passed: null, total: null, bestPoolDepth: null, decimals: null, symbol: null, name: null, launchpad: null });
    expect(list.indexedAt).toBeNull();
  });

  it("keeps at most 50 rows, and reads an unparseable indexedAt as null", () => {
    const rows = Array.from({ length: 60 }, (_, i) => row({ address: `0x${i.toString(16).padStart(40, "0")}` }));
    const list = parseRadarAnswer({ rows, indexedAt: "soon" });
    expect(list.rows).toHaveLength(50);
    expect(list.indexedAt).toBeNull();
  });
});

describe("fetchRadar", () => {
  const filters = { liquid: true, passing: false };

  it("asks the route for the feed, under a timeout, and parses its answer", async () => {
    const fetchFn = vi.fn(async () => Response.json({ rows: [row()], indexedAt: null })) as unknown as typeof fetch;
    const list = await fetchRadar(filters, fetchFn);
    expect(list.rows).toHaveLength(1);
    const [url, init] = (fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toBe("/api/radar?hasLiquidity=1");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws the status of an error answer, and null when nothing or no JSON came back", async () => {
    const status = async (code: number) => {
      const fetchFn = (async () => Response.json({ error: "x" }, { status: code })) as typeof fetch;
      return fetchRadar(filters, fetchFn).catch((e: unknown) => e);
    };
    expect(await status(404)).toMatchObject({ name: "RadarFetchError", status: 404 });
    expect(await status(503)).toMatchObject({ name: "RadarFetchError", status: 503 });
    expect(isGone(await status(404))).toBe(true);
    expect(isGone(await status(503))).toBe(false);

    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect(await fetchRadar(filters, down).catch((e: unknown) => e)).toMatchObject({ name: "RadarFetchError", status: null });
    const html = (async () => new Response("<html>", { status: 200 })) as typeof fetch;
    expect(await fetchRadar(filters, html).catch((e: unknown) => e)).toMatchObject({ name: "RadarFetchError", status: null });
    const wrong = (async () => Response.json({ nope: true })) as typeof fetch;
    expect(await fetchRadar(filters, wrong).catch((e: unknown) => e)).toMatchObject({ name: "RadarFetchError", status: null });
  });
});

describe("radarQueryOptions", () => {
  it("keys the query by feed, polls every 20 s, every 60 s after an error, and never after a 404", () => {
    const opts = radarQueryOptions({ liquid: true, passing: true }, true);
    expect(opts.queryKey).toEqual(["radar", "liquid-passing"]);
    expect(opts.enabled).toBe(true);
    expect(opts.refetchIntervalInBackground).toBe(false);
    expect(opts.retry).toBe(false);
    expect(opts.staleTime).toBe(20_000);
    expect(radarQueryOptions({ liquid: false, passing: false }, false).enabled).toBe(false);
    const interval = opts.refetchInterval as (q: { state: { status: string; error: unknown } }) => number | false;
    expect(interval({ state: { status: "success", error: null } })).toBe(20_000);
    expect(interval({ state: { status: "error", error: new RadarFetchError(503) } })).toBe(60_000);
    expect(interval({ state: { status: "error", error: new RadarFetchError(404) } })).toBe(false);
  });
});
