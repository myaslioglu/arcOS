import { describe, expect, it } from "vitest";
import { FOUR_PATH, ICON_INK, ICON_TILE, TILE_RADIUS, faviconSvg } from "../app-icon";

describe("faviconSvg", () => {
  it("draws a rounded dark tile with the 4 in the cyan accent", () => {
    const svg = faviconSvg();
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]* viewBox="0 0 32 32">/);
    expect(TILE_RADIUS).toBe(8);
    expect(svg).toContain(`<rect width="32" height="32" rx="8" fill="${ICON_TILE}"/>`);
    expect(svg).toContain(`<path d="${FOUR_PATH}" fill="${ICON_INK}"/>`);
    expect(svg.endsWith("</svg>")).toBe(true);
  });

  it("uses the desktop's dark surface and its cyan accent", () => {
    expect(ICON_TILE).toBe("#0e0e15");
    expect(ICON_INK).toBe("#34e1ff");
  });
});

describe("FOUR_PATH", () => {
  it("draws the diagonal as thick as the stem", () => {
    const [stem, , diagonal] = FOUR_PATH.split(/(?=M)/);
    const [left, , right] = stem.match(/\d+(\.\d+)?/g)!.map(Number);
    // M x1 y1 L x2 y2 H x3 L x4 y4: the H keeps y2, so the third point is (x3, y2).
    const [x1, y1, x2, y2, x3, x4, y4] = diagonal.match(/\d+(\.\d+)?/g)!.map(Number);
    const outer = [x1 + y1, x2 + y2];
    const inner = [x3 + y2, x4 + y4];
    // Both edges run at 45 degrees (x + y is constant along each)...
    expect(outer[0]).toBe(outer[1]);
    expect(inner[0]).toBeCloseTo(inner[1], 6);
    // ...and they're as far apart as the stem is wide.
    expect((inner[0] - outer[0]) / Math.SQRT2).toBeCloseTo(right - left, 2);
  });

  it("puts every edge of the stem and the bar on a whole pixel at 16px", () => {
    // 32 units drawn at 16px: an even unit is a pixel boundary.
    const [stem, bar] = FOUR_PATH.split(/(?=M)/);
    for (const part of [stem, bar]) {
      for (const n of part.match(/\d+(\.\d+)?/g)!.map(Number)) expect(n % 2, `${n} in ${part}`).toBe(0);
    }
  });
});
