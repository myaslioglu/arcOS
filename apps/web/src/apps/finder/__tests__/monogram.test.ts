import { describe, expect, it } from "vitest";
import { tokenHue, tokenMonogram } from "../monogram";

describe("tokenMonogram", () => {
  it("keeps up to three characters of the symbol, uppercased", () => {
    expect(tokenMonogram("EURC")).toBe("EUR");
    expect(tokenMonogram("1st")).toBe("1ST");
    expect(tokenMonogram("usdc")).toBe("USD");
    expect(tokenMonogram("A")).toBe("A");
    expect(tokenMonogram("cb")).toBe("CB");
  });

  it("keeps only A-Z and 0-9", () => {
    expect(tokenMonogram("$DIA")).toBe("DIA");
    expect(tokenMonogram("w.E-T_H")).toBe("WET");
    expect(tokenMonogram("U​SDC")).toBe("USD");
    expect(tokenMonogram("&lt;script&gt;")).toBe("LTS");
  });

  it("drops a non-ASCII letter instead of turning it into the ASCII one it looks like", () => {
    // Long s and sharp s uppercase to "S" and "SS"; Cyrillic Ka and fullwidth letters only look Latin.
    expect(tokenMonogram("ſOL")).toBe("OL");
    expect(tokenMonogram("ß")).toBeNull();
    expect(tokenMonogram("К")).toBeNull();
    expect(tokenMonogram("ＵＳＤ")).toBeNull();
  });

  it("falls back to the glyph when nothing is left", () => {
    expect(tokenMonogram("")).toBeNull();
    expect(tokenMonogram("🚀🚀")).toBeNull();
    expect(tokenMonogram("⌚")).toBeNull();
    expect(tokenMonogram("\u0000‮\u0007")).toBeNull();
    // Finder's own stand-ins for a symbol it hasn't read.
    expect(tokenMonogram("…")).toBeNull();
    expect(tokenMonogram("?")).toBeNull();
  });
});

describe("tokenHue", () => {
  const ACCENTS = ["var(--accent)", "var(--accent-2)", "var(--accent-3)"];

  // One address in each of the three buckets.
  const ONE_PER_ACCENT = [
    "0x000000000000000000000000000000000000dEaD",
    "0x3600000000000000000000000000000000000000",
    "0x113f3864C94ff6a14310a789bD671de5b78D6CBf",
  ];

  it("sets the letters in each accent's text twin, mixed toward the foreground to clear AA on the tile", () => {
    const seen = new Set<string>();
    for (const a of ONE_PER_ACCENT) {
      const { hue, text } = tokenHue(a);
      const accent = hue.match(/^var\((--accent(?:-[23])?)\)$/)?.[1];
      expect(accent, a).toBeDefined();
      expect(text, a).toBe(`color-mix(in oklab, var(${accent}-text) 85%, var(--fg))`);
      seen.add(hue);
    }
    expect([...seen].sort()).toEqual([...ACCENTS].sort());
  });

  it("gives an address the same hue whatever its letter case", () => {
    const a = "0x89205A3A3b2A69De6Dbf7f01ED13B2108B2c43e7";
    expect(tokenHue(a)).toEqual(tokenHue(a.toLowerCase()));
    expect(tokenHue(a)).toEqual(tokenHue(a));
  });

  it("spreads addresses over all three accents", () => {
    const hues = new Set(
      ["1", "2", "3", "4", "5", "6"].map((d) => tokenHue(`0x${"0".repeat(39)}${d}`).hue),
    );
    expect([...hues].sort()).toEqual([...ACCENTS].sort());
  });
});
