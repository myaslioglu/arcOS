import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { BACKFILL_BLOCKS, MAX_WINDOW, firstCursor, grow, nextWindow, shrink } from "../windows";

describe("firstCursor", () => {
  it("starts 24 hours back, about 170,000 blocks, never before block 0", () => {
    expect(BACKFILL_BLOCKS).toBe(170_000);
    expect(firstCursor(23_832_458)).toBe(23_662_458);
    expect(firstCursor(1_000)).toBe(0);
  });
});

describe("nextWindow", () => {
  it("starts right after the cursor and spans at most the window, inclusive", () => {
    expect(nextWindow(100, 1_000_000, MAX_WINDOW)).toEqual({ from: 101, to: 10_100 });
    expect(nextWindow(100, 150, MAX_WINDOW)).toEqual({ from: 101, to: 150 });
    expect(nextWindow(100, 101, 1)).toEqual({ from: 101, to: 101 });
  });

  it("is null once the cursor has reached the head, or passed it", () => {
    expect(nextWindow(150, 150, MAX_WINDOW)).toBeNull();
    expect(nextWindow(151, 150, MAX_WINDOW)).toBeNull();
  });

  it("never asks the node for more than 10,000 blocks, the RPC's cap (F5), however wide the span", () => {
    expect(nextWindow(0, 1e9, 50_000)).toEqual({ from: 1, to: 10_000 });
  });

  it("covers every block once, in order, window after window (property)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000 }), fc.integer({ min: 0, max: 60_000 }), fc.integer({ min: 1, max: 12_000 }), (cursor, ahead, span) => {
        const head = cursor + ahead;
        let at = cursor;
        let covered = 0;
        for (let w = nextWindow(at, head, span); w; w = nextWindow(at, head, span)) {
          expect(w.from).toBe(at + 1);
          expect(w.to - w.from + 1).toBeLessThanOrEqual(Math.min(span, MAX_WINDOW));
          covered += w.to - w.from + 1;
          at = w.to;
        }
        expect(at).toBe(head);
        expect(covered).toBe(ahead);
      }),
    );
  });
});

describe("shrink and grow", () => {
  it("halves a window the node refused, down to one block", () => {
    expect(shrink(10_000)).toBe(5_000);
    expect(shrink(3)).toBe(1);
    expect(shrink(1)).toBe(1);
  });

  it("takes the node's own suggestion when it is smaller than half", () => {
    // -32602 "query exceeds max results 20000, retry with the range 23822428-23826851": 4,424 blocks.
    expect(shrink(10_000, 4_424)).toBe(4_424);
    expect(shrink(10_000, 9_000)).toBe(5_000);
    expect(shrink(10_000, 0)).toBe(5_000);
  });

  it("grows back by doubling, never past the cap", () => {
    expect(grow(1_250)).toBe(2_500);
    expect(grow(8_000)).toBe(MAX_WINDOW);
  });
});
