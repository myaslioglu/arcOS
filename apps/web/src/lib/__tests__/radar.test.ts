import { describe, expect, it } from "vitest";
import type { TimestampLike } from "@arcos/data";
import { BEFORE_ERROR, LIQUIDITY_ERROR, PASSED_ERROR, radarAnswer, radarPage, radarQuery, type RadarFeedRead } from "../radar";

const sp = (query: string) => new URLSearchParams(query);

describe("radarQuery", () => {
  it("maps the four combinations to the four feeds, and reads 0 as absent", () => {
    expect(radarQuery(sp(""))).toEqual({ ok: true, filter: "all" });
    expect(radarQuery(sp("hasLiquidity=1"))).toEqual({ ok: true, filter: "liquid" });
    expect(radarQuery(sp("minPassed=5"))).toEqual({ ok: true, filter: "passing" });
    expect(radarQuery(sp("hasLiquidity=1&minPassed=5"))).toEqual({ ok: true, filter: "liquid-passing" });
    expect(radarQuery(sp("hasLiquidity=0&minPassed=0"))).toEqual({ ok: true, filter: "all" });
    expect(radarQuery(sp("hasLiquidity=0&minPassed=5"))).toEqual({ ok: true, filter: "passing" });
    expect(radarQuery(sp("other=1"))).toEqual({ ok: true, filter: "all" });
  });

  it("refuses a page cursor: the feed holds the newest 50 only", () => {
    expect(radarQuery(sp("before=2026-01-01T00:00:00Z"))).toEqual({ ok: false, error: BEFORE_ERROR });
    expect(radarQuery(sp("before="))).toEqual({ ok: false, error: BEFORE_ERROR });
  });

  it("refuses any minPassed but 0 or 5, and any hasLiquidity but 0 or 1", () => {
    for (const v of ["3", "6", "five"]) expect(radarQuery(sp(`minPassed=${v}`)), v).toEqual({ ok: false, error: PASSED_ERROR });
    for (const v of ["true", "2"]) expect(radarQuery(sp(`hasLiquidity=${v}`)), v).toEqual({ ok: false, error: LIQUIDITY_ERROR });
  });
});

const at = (millis: number): TimestampLike => ({
  seconds: Math.floor(millis / 1000),
  nanoseconds: (millis % 1000) * 1_000_000,
  toDate: () => new Date(millis),
  toMillis: () => millis,
});
const T0 = 1_790_000_000_000;
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const CREATOR = "0x00000000000000000000000000000000000c0ffe";

const row = (over: Record<string, unknown> = {}) => ({
  address: addr(1),
  symbol: "RDR",
  name: "Radar token",
  source: "v3",
  firstSeen: at(T0),
  passed: 6,
  total: 9,
  bestPoolDepth: "2500000000",
  decimals: 18,
  creator: CREATOR,
  ...over,
});
const read = (rows: unknown[], lastRunAt: TimestampLike | null | "none" = at(T0 + 60_000)): RadarFeedRead => ({
  feed: { rows: rows as never },
  indexer: lastRunAt === "none" ? null : { lastRunAt },
});

describe("radarPage", () => {
  it("answers each row's fields with ISO times, and the index's last run", () => {
    const page = radarPage(read([row()]), () => "Padlaunch");
    expect(page).toEqual({
      rows: [
        {
          address: addr(1), symbol: "RDR", name: "Radar token", source: "v3", firstSeen: new Date(T0).toISOString(),
          passed: 6, total: 9, bestPoolDepth: "2500000000", decimals: 18, launchpad: "Padlaunch",
        },
      ],
      indexedAt: new Date(T0 + 60_000).toISOString(),
      skipped: 0,
    });
    expect(Object.keys(page.rows[0]!)).toEqual(["address", "symbol", "name", "source", "firstSeen", "passed", "total", "bestPoolDepth", "decimals", "launchpad"]);
    expect(radarAnswer(page)).toEqual({ rows: page.rows, indexedAt: page.indexedAt });
    expect(JSON.stringify(page)).not.toContain(CREATOR);
  });

  it("gives no rows before the feed exists, and no indexedAt before the indexer has run", () => {
    expect(radarPage({ feed: null, indexer: null })).toEqual({ rows: [], indexedAt: null, skipped: 0 });
    expect(radarPage(read([], null)).indexedAt).toBeNull();
    expect(radarPage(read([], "none")).indexedAt).toBeNull();
  });

  it("reads a row written before decimals and creator existed as null for both, with no launchpad", () => {
    const lookup = (creator: string | null) => (creator === null ? null : "Padlaunch");
    const old = row();
    delete (old as Record<string, unknown>).decimals;
    delete (old as Record<string, unknown>).creator;
    expect(radarPage(read([old]), lookup).rows[0]).toMatchObject({ decimals: null, launchpad: null });
    expect(radarPage(read([row({ creator: null })]), lookup).rows[0]?.launchpad).toBeNull();
  });

  it("resolves the launchpad through the lookup given, by the stored creator", () => {
    const seen: (string | null)[] = [];
    const page = radarPage(read([row()]), (c) => {
      seen.push(c);
      return c === CREATOR ? "Padlaunch" : null;
    });
    expect(seen).toEqual([CREATOR]);
    expect(page.rows[0]?.launchpad).toBe("Padlaunch");
    expect(radarPage(read([row()])).rows[0]?.launchpad).toBeNull();
  });

  it("skips and counts a row with a bad address, an unknown source or a broken firstSeen, keeping the others", () => {
    const rows = [
      row({ address: "0xABCDEF0000000000000000000000000000000001" }),
      row({ address: "0x12" }),
      row({ address: 7 }),
      row({ source: "v5" }),
      row({ firstSeen: null }),
      row({ firstSeen: { toMillis: () => Number.NaN } }),
      row({ firstSeen: "2026-01-01" }),
      "junk",
      row({ address: addr(2) }),
    ];
    const page = radarPage(read(rows));
    expect(page.rows.map((r) => r.address)).toEqual([addr(2)]);
    expect(page.skipped).toBe(8);
  });

  it("nulls both counts when they don't make sense together, and a depth that isn't a uint", () => {
    expect(radarPage(read([row({ passed: 10, total: 9 })])).rows[0]).toMatchObject({ passed: null, total: null });
    expect(radarPage(read([row({ passed: 0, total: 0 })])).rows[0]).toMatchObject({ passed: null, total: null });
    expect(radarPage(read([row({ passed: null, total: null })])).rows[0]).toMatchObject({ passed: null, total: null });
    expect(radarPage(read([row({ passed: 1.5, total: 9 })])).rows[0]).toMatchObject({ passed: null, total: null });
    expect(radarPage(read([row({ passed: 0, total: 9 })])).rows[0]).toMatchObject({ passed: 0, total: 9 });
    expect(radarPage(read([row({ bestPoolDepth: "01" })])).rows[0]?.bestPoolDepth).toBeNull();
    expect(radarPage(read([row({ bestPoolDepth: null })])).rows[0]?.bestPoolDepth).toBeNull();
    expect(radarPage(read([row({ bestPoolDepth: 5 })])).rows[0]?.bestPoolDepth).toBeNull();
    expect(radarPage(read([row({ bestPoolDepth: "0" })])).rows[0]?.bestPoolDepth).toBe("0");
  });

  it("nulls decimals outside 0..36 or not an integer", () => {
    expect(radarPage(read([row({ decimals: 99 })])).rows[0]?.decimals).toBeNull();
    expect(radarPage(read([row({ decimals: -1 })])).rows[0]?.decimals).toBeNull();
    expect(radarPage(read([row({ decimals: 1.5 })])).rows[0]?.decimals).toBeNull();
    expect(radarPage(read([row({ decimals: null })])).rows[0]?.decimals).toBeNull();
    expect(radarPage(read([row({ decimals: 0 })])).rows[0]?.decimals).toBe(0);
    expect(radarPage(read([row({ decimals: 36 })])).rows[0]?.decimals).toBe(36);
  });

  it("cleans bidi and control characters out of the labels, and bounds them", () => {
    const page = radarPage(read([row({ symbol: "US‮DC\u0000", name: `​${"A".repeat(80)}` })]));
    expect(page.rows[0]?.symbol).toBe("USDC");
    expect(page.rows[0]?.name).toBe("A".repeat(64));
    expect(radarPage(read([row({ symbol: 5, name: null })])).rows[0]).toMatchObject({ symbol: null, name: null });
  });

  it("keeps the stored order and at most 50 rows", () => {
    const rows = Array.from({ length: 60 }, (_, i) => row({ address: addr(100 - i), firstSeen: at(T0 - i * 1000) }));
    const page = radarPage(read(rows));
    expect(page.rows).toHaveLength(50);
    expect(page.rows.map((r) => r.address)).toEqual(rows.slice(0, 50).map((r) => r.address));
    expect(page.skipped).toBe(0);
  });
});
