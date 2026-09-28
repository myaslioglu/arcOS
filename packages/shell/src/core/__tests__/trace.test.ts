import { describe, expect, it } from "vitest";
import { TRACE_BOX, TRACE_EMA_ALPHA, emaSeries, tracePoints, traceTop } from "../trace";

describe("emaSeries", () => {
  it("starts at the first value and moves toward each next one by alpha", () => {
    expect(emaSeries([0, 1, 1], 0.5)).toEqual([0, 0.5, 0.75]);
    expect(emaSeries([0.2, 0.2, 0.2])).toEqual([0.2, 0.2, 0.2]);
  });

  it("smooths over about 64 blocks by default, and is empty for no values", () => {
    expect(emaSeries([0, 1, 1])).toEqual(emaSeries([0, 1, 1], TRACE_EMA_ALPHA));
    const step = emaSeries([0, ...new Array<number>(64).fill(1)]);
    expect(step[32]).toBeGreaterThan(0.6);
    expect(step[32]).toBeLessThan(0.7);
    expect(step[64]).toBeGreaterThan(0.85);
    expect(emaSeries([])).toEqual([]);
  });
});

describe("traceTop", () => {
  it("puts the top of the axis at 1.1 times the largest value", () => {
    expect(traceTop([0.1, 0.32, 0.05])).toBeCloseTo(0.352);
  });

  it("keeps an idle or empty series on a unit axis", () => {
    expect(traceTop([0, 0, 0])).toBe(1);
    expect(traceTop([])).toBe(1);
  });
});

describe("tracePoints", () => {
  it("spreads the values across the box, with 0 at the bottom and the top at the top edge", () => {
    expect(tracePoints([0, 0.5, 1], 1, { w: 100, h: 10 })).toBe("0.0,10.0 50.0,5.0 100.0,0.0");
  });

  it("draws a flat series as a flat line", () => {
    const values = [0.2, 0.2, 0.2];
    const ys = tracePoints(values, traceTop(values))
      .split(" ")
      .map((p) => p.split(",")[1]);
    expect(new Set(ys).size).toBe(1);
  });

  it("draws nothing for fewer than two values, and keeps stray values inside the box", () => {
    expect(tracePoints([0.3], 1)).toBe("");
    expect(tracePoints([], 1)).toBe("");
    expect(tracePoints([-1, 2], 1, { w: 10, h: 10 })).toBe("0.0,10.0 10.0,0.0");
  });

  it("draws in a 1200 by 240 box by default", () => {
    expect(TRACE_BOX).toEqual({ w: 1200, h: 240 });
    expect(tracePoints([0, 1], 1)).toBe("0.0,240.0 1200.0,0.0");
  });
});
