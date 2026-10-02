import { describe, expect, it } from "vitest";
import { clampRect, MIN_WINDOW, snapRect, snapZone, tileRects, windowRect } from "../geometry";
import type { WindowSize } from "../types";

// Arbitrary window sizes spanning the range windowRect has to handle across
// stage sizes and cascade slots; not tied to any particular app.
const SIZES: Record<string, WindowSize> = {
  a: { w: 620, h: 660 },
  b: { w: 600, h: 640 },
  c: { w: 600, h: 620 },
  d: { w: 640, h: 580 },
  wide: { w: 880, h: 700 },
  narrow: { w: 520, h: 470 },
};

describe("windowRect", () => {
  const W = 1440;
  const H = 860;

  // The stage's lower edge minus the dock's clearance: no window runs under the dock.
  const floor = (h: number) => h - 76;

  it("centres the first window horizontally, a little above the middle, clear of the dock", () => {
    const r = windowRect(0, SIZES.a!, W, H);
    expect(Math.abs(r.left + r.width / 2 - W / 2)).toBeLessThanOrEqual(1);
    const space = floor(H) - 16; // the band a window may occupy, from the top margin to the dock
    const middle = 16 + space / 2;
    expect(r.top + r.height / 2).toBeLessThan(middle);
    expect(r.top).toBeGreaterThan(16);
    expect(r.top + r.height).toBeLessThanOrEqual(floor(H));
  });

  it("cascades each later window one step down and right of the one before", () => {
    const big = { w: 620, h: 480 };
    const rects = [0, 1, 2].map((slot) => windowRect(slot, big, W, H));
    for (let i = 1; i < rects.length; i++) {
      const dx = rects[i]!.left - rects[i - 1]!.left;
      const dy = rects[i]!.top - rects[i - 1]!.top;
      expect(dx).toBeGreaterThanOrEqual(24);
      expect(dx).toBeLessThanOrEqual(32);
      expect(dy).toBe(dx);
      // Partly overlapping, never side by side.
      expect(rects[i]!.left).toBeLessThan(rects[i - 1]!.left + rects[i - 1]!.width);
    }
  });

  it("steps title bars and centres down and right even when the windows differ in size", () => {
    const sizes = [SIZES.narrow!, { w: 460, h: 360 }, { w: 640, h: 420 }];
    const rects = sizes.map((size, slot) => windowRect(slot, size, W, H));
    for (let i = 1; i < rects.length; i++) {
      const prev = rects[i - 1]!;
      const r = rects[i]!;
      expect(r.top - prev.top).toBe(28);
      expect(r.left + r.width / 2 - (prev.left + prev.width / 2)).toBeCloseTo(28, 0);
    }
  });

  it("never opens a window pinned to the left or right edge of a wide stage", () => {
    for (let slot = 0; slot < 8; slot++) {
      const r = windowRect(slot, SIZES.a!, W, H);
      expect(r.left).toBeGreaterThan(16 + 200);
      expect(r.left + r.width).toBeLessThan(W - 16 - 200);
    }
  });

  it("wraps into a new column before the dock, every slot in its own place on a stage with room", () => {
    const rects = Array.from({ length: 8 }, (_, slot) => windowRect(slot, SIZES.a!, W, H));
    const first = rects[0]!;
    // A tall window has little room below it: the cascade turns back up before it would be clamped.
    const wrap = rects.findIndex((r, i) => i > 0 && r.top < rects[i - 1]!.top);
    expect(wrap).toBeGreaterThan(0);
    expect(rects[wrap]!.top).toBe(first.top);
    expect(rects[wrap]!.left).toBeGreaterThan(first.left);
    // On a stage with room every slot lands somewhere distinct, so no window hides another exactly. (On a stage
    // with no room to spare, such as 300x300 below, slots may share a rect; the clamps still hold.)
    const keys = new Set(rects.map((r) => `${r.left},${r.top}`));
    expect(keys.size).toBe(rects.length);
    for (const r of rects) expect(r.top + r.height).toBeLessThanOrEqual(floor(H));
  });

  it("is the same rect for the same slot and stage", () => {
    expect(windowRect(3, SIZES.b!, W, H)).toEqual(windowRect(3, SIZES.b!, W, H));
  });

  it("fits a phone-width stage: full usable width, cascading down only", () => {
    const a = windowRect(0, SIZES.a!, 390, 800);
    const b = windowRect(1, SIZES.a!, 390, 800);
    expect(a.left).toBe(16);
    expect(a.width).toBe(390 - 32);
    expect(b.left).toBe(16);
    expect(b.top).toBeGreaterThan(a.top);
    expect(b.top + b.height).toBeLessThanOrEqual(floor(800));
  });

  it("handles differently sized windows, never leaves the stage, never runs under the dock", () => {
    expect(windowRect(0, SIZES.wide!, W, H).width).toBeGreaterThan(windowRect(0, SIZES.narrow!, W, H).width);
    const stages = [
      [1440, 860],
      [1024, 700],
      [800, 560],
      [390, 800],
      [1280, 720],
      [1920, 1080],
      [300, 300],
    ] as const;
    for (const [w, h] of stages) {
      for (const size of Object.values(SIZES)) {
        for (let slot = 0; slot < 8; slot++) {
          const r = windowRect(slot, size, w, h);
          expect(r.left).toBeGreaterThanOrEqual(0);
          expect(r.top).toBeGreaterThanOrEqual(0);
          expect(r.left + r.width).toBeLessThanOrEqual(w);
          expect(r.top + r.height).toBeLessThanOrEqual(h);
          expect(r.top + r.height).toBeLessThanOrEqual(floor(h));
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
