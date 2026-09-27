import { describe, expect, it } from "vitest";
import { FOUR_PATH, ICON_INK, ICON_TILE, faviconSvg } from "../app-icon";

describe("faviconSvg", () => {
  it("draws a rounded dark tile with the 4 in the cyan accent", () => {
    const svg = faviconSvg();
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]* viewBox="0 0 32 32">/);
    expect(svg).toMatch(new RegExp(`<rect width="32" height="32" rx="\\d+" fill="${ICON_TILE}"/>`));
    expect(svg).toContain(`<path d="${FOUR_PATH}" fill="${ICON_INK}"/>`);
    expect(svg.endsWith("</svg>")).toBe(true);
  });

  it("uses the desktop's dark surface and its cyan accent", () => {
    expect(ICON_TILE).toBe("#0e0e15");
    expect(ICON_INK).toBe("#34e1ff");
  });
});

describe("FOUR_PATH", () => {
  it("puts every edge of the stem and the bar on a whole pixel at 16px", () => {
    // 32 units drawn at 16px: an even unit is a pixel boundary.
    const [stem, bar] = FOUR_PATH.split(/(?=M)/);
    for (const part of [stem, bar]) {
      for (const n of part.match(/\d+(\.\d+)?/g)!.map(Number)) expect(n % 2, `${n} in ${part}`).toBe(0);
    }
  });
});
