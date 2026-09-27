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

  it("picks one of the accent tokens, with its text-safe twin", () => {
    const { hue, text } = tokenHue("0x3600000000000000000000000000000000000000");
    expect(ACCENTS).toContain(hue);
    expect(text).toBe(hue.replace(")", "-text)"));
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
