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

  it("a comma is never read as a decimal point", () => {
    // "1,5" isn't a thousands-grouped number (that needs groups of exactly 3 digits), so it's a format error.
    expect(amountIssue("1,5")).toMatch(/isn't a number/);
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

  it("returns null for empty, zero or invalid input", () => {
    expect(normalizedAmount("")).toBeNull();
    expect(normalizedAmount("0")).toBeNull();
    expect(normalizedAmount("abc")).toBeNull();
    expect(normalizedAmount("1,5")).toBeNull();
  });
});
