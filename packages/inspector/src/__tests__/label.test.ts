import { describe, expect, it } from "vitest";
import { cleanLabel } from "../label";

describe("cleanLabel", () => {
  it("leaves plain text unchanged", () => {
    expect(cleanLabel("USDC", 64)).toBe("USDC");
  });

  it("removes a bidi override used to spoof a symbol", () => {
    expect(cleanLabel("US‮DC", 64)).toBe("USDC");
  });

  it("removes zero-width characters", () => {
    expect(cleanLabel("A​B﻿", 64)).toBe("AB");
  });

  it("collapses runs of whitespace, including newlines, to one space", () => {
    expect(cleanLabel("  many   spaces \n here ", 64)).toBe("many spaces here");
  });

  it("truncates to maxLength code points", () => {
    expect(cleanLabel("a".repeat(100), 64)).toBe("a".repeat(64));
  });

  it("truncates on a code-point boundary, never splitting a surrogate pair", () => {
    const result = cleanLabel("\u{1F600}".repeat(40), 32);
    expect(result).toBe("\u{1F600}".repeat(32));
    expect([...result!].length).toBe(32);
  });

  it("returns null when only zero-width characters remain", () => {
    expect(cleanLabel("​​", 64)).toBeNull();
  });

  it("returns null for null", () => {
    expect(cleanLabel(null, 64)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(cleanLabel(undefined, 64)).toBeNull();
  });

  it("returns null for a non-string value", () => {
    expect(cleanLabel(123 as unknown as string, 64)).toBeNull();
  });
});
