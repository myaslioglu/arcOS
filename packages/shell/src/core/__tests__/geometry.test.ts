import { describe, expect, it } from "vitest";
import { clampRect, MIN_WINDOW, snapRect, snapZone, tileRects, windowRect } from "../geometry";
import type { WindowSize } from "../types";

// The old kind → size table this window sizing used to look up before the
// manifest took over; kept here only to drive the ported windowRect tests.
const SIZES: Record<string, WindowSize> = {
  publication: { w: 620, h: 660 },
  note: { w: 600, h: 640 },
  folder: { w: 600, h: 620 },
  project: { w: 640, h: 580 },
  app: { w: 880, h: 700 },
  system: { w: 520, h: 470 },
};

describe("windowRect", () => {
  const W = 1440;
  const H = 860;

  it("opens the first window against the right edge, clear of the dock", () => {
    const r = windowRect(0, SIZES.publication!, W, H);
    expect(r.left + r.width).toBe(W - 16);
    expect(r.top).toBe(16);
    expect(r.top + r.height).toBeLessThanOrEqual(H - 60);
  });

  it("tiles the second window beside the first when both fit", () => {
    const a = windowRect(0, SIZES.publication!, W, H);
    const b = windowRect(1, SIZES.publication!, W, H);
    expect(b.left).toBe(16);
    expect(b.left + b.width).toBeLessThanOrEqual(a.left);
  });

  it("cascades on a stage too narrow for two", () => {
    const a = windowRect(0, SIZES.publication!, 1000, H);
    const b = windowRect(1, SIZES.publication!, 1000, H);
    expect(b.left).toBeLessThan(a.left);
    expect(b.top).toBeGreaterThan(a.top);
  });

  it("sizes by kind and never leaves the stage", () => {
    expect(windowRect(0, SIZES.app!, W, H).width).toBeGreaterThan(windowRect(0, SIZES.system!, W, H).width);
    const stages = [
      [1440, 860],
      [1024, 700],
      [800, 560],
      [390, 800],
    ] as const;
    for (const [w, h] of stages) {
      for (const size of Object.values(SIZES)) {
        for (let slot = 0; slot < 8; slot++) {
          const r = windowRect(slot, size, w, h);
          expect(r.left).toBeGreaterThanOrEqual(0);
          expect(r.top).toBeGreaterThanOrEqual(0);
          expect(r.left + r.width).toBeLessThanOrEqual(w);
          expect(r.top + r.height).toBeLessThanOrEqual(h);
        }
      }
    }
  });
});

describe("tileRects", () => {
  const W = 1440;
  const H = 860;

  it("fills a grid row by row, the last row sharing its width", () => {
    const r = tileRects(3, W, H);
    expect(r).toHaveLength(3);
    expect(r[0].top).toBe(r[1].top);
    expect(r[2].top).toBeGreaterThan(r[0].top);
    expect(r[2].width).toBeGreaterThan(r[0].width);
    expect(tileRects(0, W, H)).toEqual([]);
  });

  it("never overlaps, never leaves the stage, never runs under the dock", () => {
    for (let n = 1; n <= 7; n++) {
      const rects = tileRects(n, W, H);
      for (const r of rects) {
        expect(r.left).toBeGreaterThanOrEqual(0);
        expect(r.left + r.width).toBeLessThanOrEqual(W);
        expect(r.top + r.height).toBeLessThanOrEqual(H - 60);
      }
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i];
          const b = rects[j];
          const apart =
            a.left + a.width <= b.left ||
            b.left + b.width <= a.left ||
            a.top + a.height <= b.top ||
            b.top + b.height <= a.top;
          expect(apart, `${n} windows: ${i} and ${j}`).toBe(true);
        }
      }
    }
  });
});

describe("snapping", () => {
  it("reads which edge a title bar is pressed into", () => {
    expect(snapZone(4, 300, 1440)).toBe("left");
    expect(snapZone(1436, 300, 1440)).toBe("right");
    expect(snapZone(700, 2, 1440)).toBe("top");
    expect(snapZone(700, -20, 1440)).toBe("top");
    expect(snapZone(700, 300, 1440)).toBeNull();
  });

  it("fills two halves side by side, clear of the dock", () => {
    const l = snapRect("left", 1440, 860);
    const r = snapRect("right", 1440, 860);
    expect(l.left + l.width).toBeLessThanOrEqual(r.left);
    expect(r.left + r.width).toBeLessThanOrEqual(1440);
    expect(l.top + l.height).toBeLessThanOrEqual(860 - 60);
    expect(snapRect("top", 1440, 860).width).toBeGreaterThan(l.width);
  });
});

describe("clampRect", () => {
  it("keeps a remembered window usable after the stage shrinks", () => {
    const r = clampRect({ left: 1300, top: 900, width: 2000, height: 50 }, 1024, 700);
    expect(r.width).toBeLessThanOrEqual(1024);
    expect(r.height).toBe(MIN_WINDOW.h);
    expect(r.left).toBeLessThanOrEqual(1024 - 120);
    expect(r.top).toBeLessThanOrEqual(700 - 48);
  });
});
