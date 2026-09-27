import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  AmountError,
  DUST_FACTOR,
  formatUsdc,
  hasLoneComma,
  nativeToUnits,
  parseTokenAmount,
  parseUsdc,
  unitsToNative,
} from "../amounts";

/** Parses `s` as USDC and reports what happened, without throwing — for tests that need to inspect
 * the error's code and message together instead of catching twice. */
const attemptUsdc = (s: string): "no-throw" | { code: string; message: string } => {
  try {
    parseUsdc(s);
    return "no-throw";
  } catch (e) {
    return { code: (e as AmountError).code, message: (e as AmountError).message };
  }
};

describe("parseUsdc", () => {
  it("parses whole and fractional amounts into 18-decimal wei", () => {
    expect(parseUsdc("1")).toBe(10n ** 18n);
    expect(parseUsdc("0.05")).toBe(5n * 10n ** 16n);
    expect(parseUsdc("1,234.5")).toBe(12345n * 10n ** 17n);
    expect(parseUsdc(" 15 ")).toBe(15n * 10n ** 18n);
  });

  it("accepts exactly 6 decimal places and rejects a 7th", () => {
    expect(parseUsdc("0.000001")).toBe(10n ** 12n);
    expect(() => parseUsdc("0.0000001")).toThrowError(AmountError);
  });

  it("rejects empty, negative and malformed input with a code", () => {
    const code = (s: string) => {
      try {
        parseUsdc(s);
      } catch (e) {
        return (e as AmountError).code;
      }
      return "no-throw";
    };
    expect(code("")).toBe("empty");
    expect(code("-1")).toBe("negative");
    expect(code("1.2.3")).toBe("format");
    expect(code("abc")).toBe("format");
    expect(code("1e6")).toBe("format");
    expect(code("0.1234567")).toBe("precision");
  });

  it("reads a comma as thousands when there's a dot, or two or more groups — exactly as before", () => {
    expect(parseUsdc("1,234.5")).toBe(12345n * 10n ** 17n);
    expect(parseUsdc("1,000,000")).toBe(10n ** 24n);
  });

  it("reads a lone comma with no dot as a decimal point, for 1, 2 or 4+ digits after it", () => {
    expect(parseUsdc("1,5")).toBe(15n * 10n ** 17n);
    expect(parseUsdc("0,25")).toBe(25n * 10n ** 16n);
    expect(parseUsdc("1000,5")).toBe(10005n * 10n ** 17n);
    expect(parseTokenAmount("12,3456", 6)).toBe(12_345_600n);
  });

  // The brief's own examples for this row, missing from the first pass (review m6).
  it("reads the brief's own missing examples the same as their dot twin", () => {
    expect(parseUsdc("1,50")).toBe(parseUsdc("1.50"));
    expect(parseUsdc("1,2345")).toBe(parseUsdc("1.2345"));
  });

  it("reads exactly 3 digits after a lone comma as a decimal point once 4+ digits lead it — no thousands group starts with 4+ digits", () => {
    expect(parseUsdc("1000,000")).toBe(1000n * 10n ** 18n);
  });

  // m2: a leading zero rules out a thousands reading on its own — no group starts with 0 — so it's
  // always a decimal comma, never ambiguous, regardless of how many digits follow.
  it("reads a leading zero before the comma as a decimal point, never as ambiguous", () => {
    expect(parseTokenAmount("0,250", 8)).toBe(parseTokenAmount("0.250", 8));
    expect(parseTokenAmount("0,125", 8)).toBe(parseTokenAmount("0.125", 8));
    expect(parseTokenAmount("0,000", 6)).toBe(0n);
    expect(parseTokenAmount("00,250", 6)).toBe(parseTokenAmount("0.250", 6));
  });

  it("refuses exactly 3 digits after a lone comma, with a nonzero leading digit and 1-3 digits before it, as ambiguous — naming both readings", () => {
    expect(attemptUsdc("1,500")).toEqual({ code: "ambiguous", message: '"1,500" could mean 1500 or 1.5. Write 1500, or 1.5 with a dot.' });
    expect(attemptUsdc("12,345")).toEqual({ code: "ambiguous", message: '"12,345" could mean 12345 or 12.345. Write 12345, or 12.345 with a dot.' });
    // I1: the rule's upper edge — three digits before the comma — pinned by an exact example, not
    // just the property below.
    expect(attemptUsdc("100,000")).toEqual({ code: "ambiguous", message: '"100,000" could mean 100000 or 100. Write 100000 or 100.' });
  });

  // m1: when the decimal reading is a whole number (the common case for someone who groups
  // thousands with a comma — round thousands), the message drops "with a dot", which can't be
  // typed on the comma-only keypad that motivated this fix in the first place.
  it("drops 'with a dot' from the ambiguous message when the decimal reading is a whole number", () => {
    expect(attemptUsdc("5,000")).toEqual({ code: "ambiguous", message: '"5,000" could mean 5000 or 5. Write 5000 or 5.' });
    expect(attemptUsdc("10,000")).toEqual({ code: "ambiguous", message: '"10,000" could mean 10000 or 10. Write 10000 or 10.' });
  });

  // I1: decided on the TRIMMED text — surrounding whitespace changes neither the reading nor what
  // the message quotes (m4). This is also the mutant (M6) that let the original 1000x over-read
  // back in for padded input.
  it("decides ambiguity on the trimmed text, and quotes the trimmed text back — padding changes nothing", () => {
    expect(attemptUsdc(" 1,500 ")).toEqual({ code: "ambiguous", message: '"1,500" could mean 1500 or 1.5. Write 1500, or 1.5 with a dot.' });
    expect(parseUsdc(" 1,5 ")).toBe(15n * 10n ** 17n);
  });

  // I1: the property behind the two examples above — for any 1-3 digit whole part with a nonzero
  // leading digit, a comma, and exactly 3 digits, with or without surrounding whitespace, the code
  // is always "ambiguous". fc.pre(w[0] !== "0") reflects m2's leading-zero exception.
  it("is always ambiguous for 1-3 digits (no leading zero), a comma, and 3 digits, with or without surrounding whitespace", () => {
    const digit = fc.constantFrom("0", "1", "2", "3", "4", "5", "6", "7", "8", "9");
    const pad = fc.constantFrom("", " ", "\t", "\u00a0");
    fc.assert(
      fc.property(
        fc.array(digit, { minLength: 1, maxLength: 3 }),
        fc.array(digit, { minLength: 3, maxLength: 3 }),
        pad,
        pad,
        (wDigits, dDigits, before, after) => {
          fc.pre(wDigits[0] !== "0");
          const text = `${before}${wDigits.join("")},${dDigits.join("")}${after}`;
          const result = attemptUsdc(text);
          expect(result === "no-throw" ? result : result.code).toBe("ambiguous");
        },
      ),
    );
  });

  it("quotes the trimmed text in the format message too, capped at 24 characters plus '…'", () => {
    expect(attemptUsdc(" abc ")).toEqual({ code: "format", message: '"abc" isn\'t a number' });
    const long = "1".repeat(30) + "x"; // a 31-character shape SHAPE never accepts
    expect(attemptUsdc(` ${long} `)).toEqual({ code: "format", message: `"${"1".repeat(24)}…" isn't a number` });
  });

  it("still refuses a shape that was never valid: a stray comma, a double comma, or a comma after a dot", () => {
    for (const bad of [",5", "5,", "1,,2.5", "1.5,000"]) {
      expect(() => parseUsdc(bad), bad).toThrowError(AmountError);
      try {
        parseUsdc(bad);
      } catch (e) {
        expect((e as AmountError).code, bad).toBe("format");
      }
    }
  });

  it("is exact at 18 and at 0 decimals too, not just USDC's 6", () => {
    expect(parseTokenAmount("1,5", 18)).toBe(parseTokenAmount("1.5", 18));
    const codeAt0 = (s: string) => {
      try {
        parseTokenAmount(s, 0);
        return "no-throw";
      } catch (e) {
        return (e as AmountError).code;
      }
    };
    expect(codeAt0("1,5")).toBe("precision"); // a decimal comma is still a fractional digit at 0 decimals
    expect(codeAt0("1,5")).toBe(codeAt0("1.5"));
  });
});

describe("hasLoneComma", () => {
  it("is true for exactly one comma and no dot, ambiguous or not", () => {
    expect(hasLoneComma("1,5")).toBe(true);
    expect(hasLoneComma("1,500")).toBe(true);
    expect(hasLoneComma("100,1")).toBe(true);
    expect(hasLoneComma(" 1,5 ")).toBe(true); // trims first
  });

  it("is false for a dot, two or more commas, or no comma at all", () => {
    expect(hasLoneComma("1,234.5")).toBe(false);
    expect(hasLoneComma("1,000,000")).toBe(false);
    expect(hasLoneComma("1.5")).toBe(false);
    expect(hasLoneComma("5")).toBe(false);
    expect(hasLoneComma("1,,5")).toBe(false);
  });
});

describe("unit conversion", () => {
  it("never produces dust from a parsed amount", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 15n }), (units) => {
        const wei = unitsToNative(units);
        expect(wei % DUST_FACTOR).toBe(0n);
        expect(nativeToUnits(wei)).toEqual({ units, dust: 0n });
      }),
    );
  });

  it("reports dust instead of silently dropping it", () => {
    expect(nativeToUnits(10n ** 12n + 7n)).toEqual({ units: 1n, dust: 7n });
  });

  it("round-trips through format and parse", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 15n }), (units) => {
        const wei = unitsToNative(units);
        expect(parseUsdc(formatUsdc(wei))).toBe(wei);
      }),
    );
  });
});

describe("formatUsdc", () => {
  it("trims trailing zeros and keeps at most 6 places", () => {
    expect(formatUsdc(15n * 10n ** 18n)).toBe("15");
    expect(formatUsdc(5n * 10n ** 16n)).toBe("0.05");
    expect(formatUsdc(10n ** 12n)).toBe("0.000001");
    expect(formatUsdc(10n ** 12n + 7n)).toBe("0.000001");
  });
});

describe("parseTokenAmount", () => {
  it("respects the token's own decimals", () => {
    expect(parseTokenAmount("1.5", 18)).toBe(15n * 10n ** 17n);
    expect(parseTokenAmount("1.5", 6)).toBe(1_500_000n);
    expect(parseTokenAmount("7", 0)).toBe(7n);
    expect(() => parseTokenAmount("1.5", 0)).toThrowError(AmountError);
  });

  it("accepts a value scaled exactly to uint256's max", () => {
    const max = 2n ** 256n - 1n;
    expect(parseTokenAmount(max.toString(), 0)).toBe(max);
  });

  it("rejects a value that overflows uint256 after scaling by decimals, with a readable message", () => {
    const oneOverMax = (2n ** 256n).toString(); // uint256 max + 1, decimals: 0
    expect(() => parseTokenAmount(oneOverMax, 0)).toThrowError(AmountError);
    try {
      parseTokenAmount(oneOverMax, 0);
    } catch (e) {
      expect((e as AmountError).code).toBe("overflow");
      expect((e as AmountError).message).toBe("That number is too large.");
    }

    // A value that's small on its own only overflows once scaled by decimals — the check has to run
    // AFTER scaling, not just on the raw digits typed.
    const huge = "1" + "0".repeat(60); // 10^60 * 10^18 = 10^78 > 2^256-1 (~1.158e77)
    expect(() => parseTokenAmount(huge, 18)).toThrowError(AmountError);
  });

  it("counts a decimal comma toward the decimal places exactly like a dot does", () => {
    expect(() => parseTokenAmount("0,1234567", 6)).toThrowError(AmountError);
    try {
      parseTokenAmount("0,1234567", 6);
    } catch (e) {
      expect((e as AmountError).code).toBe("precision");
    }
  });

  it("reads a lone decimal comma exactly like a dot, for any whole number and 1, 2 or 4-6 fractional digits", () => {
    fc.assert(
      fc.property(fc.nat({ max: 1_000_000 }), fc.constantFrom(1, 2, 4, 5, 6), fc.nat(), (w, len, dRaw) => {
        const d = (dRaw % 10 ** len).toString().padStart(len, "0");
        expect(parseTokenAmount(`${w},${d}`, 6)).toBe(parseTokenAmount(`${w}.${d}`, 6));
      }),
    );
  });
});
