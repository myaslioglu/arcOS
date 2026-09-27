import { describe, expect, it } from "vitest";
import { amountIssue, normalizedAmount } from "../amount";

describe("amountIssue", () => {
  it("is null for an empty box — no error shown before the user types anything", () => {
    expect(amountIssue("")).toBeNull();
    expect(amountIssue("   ")).toBeNull();
  });

  it("is null for a valid, non-zero amount", () => {
    expect(amountIssue("10")).toBeNull();
    expect(amountIssue("1,250.50")).toBeNull();
  });

  it("flags zero as its own message, distinct from a format error", () => {
    expect(amountIssue("0")).toBe("Amount must be more than zero");
  });

  it("flags more than 6 decimal places", () => {
    expect(amountIssue("1.1234567")).toMatch(/6 decimal/);
  });

  it("reads a lone decimal comma the same as a dot", () => {
    expect(amountIssue("1,5")).toBeNull();
  });

  it("refuses a lone comma with exactly three digits after it as ambiguous, naming both readings", () => {
    expect(amountIssue("1,500")).toBe('"1,500" could mean 1500 or 1.5. Write 1500, or 1.5 with a dot.');
  });

  it("flags a negative amount", () => {
    expect(amountIssue("-1")).toMatch(/negative/);
  });
});

describe("normalizedAmount", () => {
  it("returns a comma-free canonical decimal string for a valid amount", () => {
    expect(normalizedAmount("1,250.50")).toBe("1250.5");
    expect(normalizedAmount("10")).toBe("10");
  });

  it("reads a lone decimal comma the same as a dot", () => {
    expect(normalizedAmount("1,5")).toBe("1.5");
  });

  it("returns null for empty, zero, invalid or ambiguous input", () => {
    expect(normalizedAmount("")).toBeNull();
    expect(normalizedAmount("0")).toBeNull();
    expect(normalizedAmount("abc")).toBeNull();
    expect(normalizedAmount("1,500")).toBeNull(); // ambiguous, refused rather than guessed at
  });
});

// A Swap token isn't always USDC-shaped: cirBTC uses 8 decimal places, not 6. Both functions take
// the input token's own decimals so the message — and what counts as valid — matches the token on
// screen, not a hardcoded USDC assumption. Decimals defaults to 6 (USDC/EURC) so every call above,
// and Bridge's USDC-only amount box, are unaffected.
describe("amountIssue with a token's own decimals", () => {
  it("accepts cirBTC's 8th decimal place, which a 6-decimal token would refuse", () => {
    expect(amountIssue("0.12345678", 8)).toBeNull();
  });

  it("still refuses a 9th decimal place for an 8-decimal token, with the right count in the message", () => {
    expect(amountIssue("0.123456789", 8)).toMatch(/8 decimal/);
  });

  it("refuses cirBTC's 8th decimal place for a 6-decimal token (USDC/EURC)", () => {
    expect(amountIssue("0.12345678", 6)).toMatch(/6 decimal/);
  });
});

describe("normalizedAmount with a token's own decimals", () => {
  it("preserves all 8 places for an 8-decimal token instead of truncating at 6", () => {
    expect(normalizedAmount("0.12345678", 8)).toBe("0.12345678");
  });

  it("trims trailing zeros the same way regardless of decimals", () => {
    expect(normalizedAmount("1,250.50", 6)).toBe("1250.5");
    expect(normalizedAmount("1.50000000", 8)).toBe("1.5");
  });

  it("returns null for more decimal places than the token allows", () => {
    expect(normalizedAmount("0.123456789", 8)).toBeNull();
  });
});
