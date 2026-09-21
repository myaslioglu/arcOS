import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  AmountError,
  DUST_FACTOR,
  formatUsdc,
  nativeToUnits,
  parseTokenAmount,
  parseUsdc,
  unitsToNative,
} from "../amounts";

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

  it("treats a comma as a thousands separator only, never as a decimal point", () => {
    expect(parseUsdc("1,234.5")).toBe(12345n * 10n ** 17n);
    expect(parseUsdc("1,000,000")).toBe(10n ** 24n);
    expect(parseUsdc("12,345")).toBe(12345n * 10n ** 18n);
    for (const bad of ["1,5", "1,50", "1,,2.5", ",5", "5,", "1000,000", "1,2345", "1.5,000"]) {
      expect(() => parseUsdc(bad), bad).toThrowError(AmountError);
      try {
        parseUsdc(bad);
      } catch (e) {
        expect((e as AmountError).code, bad).toBe("format");
      }
    }
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
});
