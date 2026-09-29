import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { amountFromString, amountToString } from "../amounts";
import { DataError } from "../errors";

const UINT256_MAX = 2n ** 256n - 1n;

/** The message and code of what a call refused with; fails the test when it throws anything but a DataError. */
function refusal(run: () => unknown): { code: string; message: string } {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DataError);
    return { code: (error as DataError).code, message: (error as DataError).message };
  }
  throw new Error("expected the call to throw");
}

describe("amountToString", () => {
  it("writes a whole number as decimal digits", () => {
    expect(amountToString(0n)).toBe("0");
    expect(amountToString(1_000_000n)).toBe("1000000");
    expect(amountToString(10n ** 24n)).toBe("1000000000000000000000000");
    expect(amountToString(UINT256_MAX)).toBe(UINT256_MAX.toString());
  });

  it("keeps the digits a JavaScript number would lose above 2^53, which is why amounts are strings", () => {
    const beyond = 2n ** 53n + 1n;
    expect(amountToString(beyond)).toBe("9007199254740993");
    expect(String(Number(beyond))).toBe("9007199254740992");
  });

  it("refuses a negative, a value above uint256 and anything that is not a bigint", () => {
    expect(refusal(() => amountToString(-1n)).code).toBe("amount");
    expect(refusal(() => amountToString(2n ** 256n)).code).toBe("amount");
    for (const value of [1, "1", null, undefined]) expect(refusal(() => amountToString(value as never)).code).toBe("amount");
  });
});

describe("amountFromString", () => {
  it("reads decimal digits exactly", () => {
    expect(amountFromString("0")).toBe(0n);
    expect(amountFromString("7")).toBe(7n);
    expect(amountFromString("123456789012345678901234567890")).toBe(123456789012345678901234567890n);
    expect(amountFromString(UINT256_MAX.toString())).toBe(UINT256_MAX);
  });

  it("refuses everything but canonical digits: no sign, fraction, exponent, separator, space, leading zero or hex", () => {
    const arabicIndic = String.fromCharCode(0x661, 0x662, 0x663);
    const bad = ["", "-1", "+1", "01", "00", "1.5", "1e3", " 1", "1 ", "1\n", "0x10", "1,000", "NaN", arabicIndic];
    for (const text of bad) expect(refusal(() => amountFromString(text)).code, JSON.stringify(text)).toBe("amount");
    for (const text of [undefined, null, 5, 5n]) expect(refusal(() => amountFromString(text as never)).code).toBe("amount");
  });

  it("refuses a value above uint256, and a long string before it is parsed", () => {
    expect(refusal(() => amountFromString((UINT256_MAX + 1n).toString())).code).toBe("amount");
    expect(refusal(() => amountFromString("9".repeat(78))).code).toBe("amount");
    expect(refusal(() => amountFromString("9".repeat(79))).code).toBe("amount");
    expect(refusal(() => amountFromString("1".repeat(1_000_000))).code).toBe("amount");
  });

  it("never repeats what it refused", () => {
    expect(refusal(() => amountFromString("12345678901234567890x")).message).not.toContain("12345678901234567890");
  });
});

describe("amounts, for any value", () => {
  it("survive a round trip through their string", () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: UINT256_MAX }), (value) => amountFromString(amountToString(value)) === value));
  });
});
