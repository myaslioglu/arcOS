import { describe, expect, it } from "vitest";
import { RADAR_FEED_SIZE, type RadarRow, type TokenDoc } from "@arcos/data";
import { feedRow, inFeed, updateFeed } from "../feed";
import { at, token } from "./helpers";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const t = (n: number, over: Partial<TokenDoc> = {}) => token({ address: addr(n), firstSeen: at(1_790_000_000_000 + n * 1_000), ...over });
const rowsOf = (...ns: number[]) => ns.map((n) => feedRow(t(n)));
const ids = (rows: RadarRow[]) => rows.map((r) => Number(BigInt(r.address)));

describe("feedRow", () => {
  it("carries Radar's row fields, with the report's counts and the best pool's depth when there are any", () => {
    const inspected = t(1, {
      symbol: "TEST",
      name: "Test",
      report: { passed: 6, total: 8, counts: { pass: 6, warn: 1, fail: 0, unknown: 1 }, block: 9, at: at(5) },
      bestPool: { id: addr(99), version: "v3", depthUsdc: "2500000000" },
    });
    expect(feedRow(inspected)).toEqual({
      address: addr(1), symbol: "TEST", name: "Test", source: "v4", firstSeen: inspected.firstSeen, passed: 6, total: 8, bestPoolDepth: "2500000000",
      decimals: null, creator: null,
    });
    expect(feedRow(t(2))).toMatchObject({ passed: null, total: null, bestPoolDepth: null });
  });

  it("carries the token's decimals and its creator, so a row can be dragged and attributed to a launchpad", () => {
    const minted = t(3, { source: "factory", decimals: 18, creator: addr(0xc0ffee) });
    expect(feedRow(minted)).toMatchObject({ decimals: 18, creator: addr(0xc0ffee) });
  });

  it("keeps a missing decimals or creator as null, never undefined, since Firestore refuses undefined", () => {
    const row = feedRow(t(4, { decimals: null, creator: null }));
    expect(row.decimals).toBeNull();
    expect(row.creator).toBeNull();
    expect(Object.values(row)).not.toContain(undefined);
  });
});

describe("inFeed", () => {
  it("puts every token in all, and the others by the stored flags", () => {
    const both = t(1, { radar: { liquid: true, passing: true } });
    const liquid = t(2, { radar: { liquid: true, passing: false } });
    expect(["all", "liquid", "passing", "liquid-passing"].map((f) => inFeed(f as never, both))).toEqual([true, true, true, true]);
    expect(["all", "liquid", "passing", "liquid-passing"].map((f) => inFeed(f as never, liquid))).toEqual([true, true, false, false]);
    expect(["all", "liquid", "passing", "liquid-passing"].map((f) => inFeed(f as never, t(3)))).toEqual([true, false, false, false]);
  });
});

describe("updateFeed", () => {
  it("adds new tokens newest first", () => {
    const { rows, refill } = updateFeed(rowsOf(5, 3), [t(4), t(9)], "all");
    expect(ids(rows)).toEqual([9, 5, 4, 3]);
    expect(refill).toBe(false);
  });

  it("replaces a token's row instead of repeating it", () => {
    const named = t(5, { symbol: "NEW" });
    const { rows } = updateFeed(rowsOf(5, 3), [named], "all");
    expect(ids(rows)).toEqual([5, 3]);
    expect(rows[0]?.symbol).toBe("NEW");
  });

  it("keeps one page: a token older than a full page's last row stays out", () => {
    const full = rowsOf(...Array.from({ length: RADAR_FEED_SIZE }, (_, i) => 1_000 - i));
    const { rows, refill } = updateFeed(full, [t(1), t(2_000)], "all");
    expect(rows).toHaveLength(RADAR_FEED_SIZE);
    expect(ids(rows)[0]).toBe(2_000);
    expect(ids(rows)).not.toContain(1);
    expect(refill).toBe(false);
  });

  it("drops a token that no longer matches, and asks for a refill only when a full page lost a row", () => {
    const liquidRows = [t(5, { radar: { liquid: true, passing: false } }), t(3, { radar: { liquid: true, passing: false } })].map(feedRow);
    const drained = t(5, { radar: { liquid: false, passing: false } });
    expect(updateFeed(liquidRows, [drained], "liquid")).toEqual({ rows: [liquidRows[1]], refill: false });

    const full = Array.from({ length: RADAR_FEED_SIZE }, (_, i) => feedRow(t(1_000 - i, { radar: { liquid: true, passing: false } })));
    const out = updateFeed(full, [t(1_000)], "liquid");
    expect(out.rows).toHaveLength(RADAR_FEED_SIZE - 1);
    expect(out.refill).toBe(true);
  });

  it("orders ties on firstSeen by address, so two runs build the same page", () => {
    const same = at(1_790_000_000_000);
    const { rows } = updateFeed([], [t(2, { firstSeen: same }), t(1, { firstSeen: same })], "all");
    expect(ids(rows)).toEqual([1, 2]);
  });
});
