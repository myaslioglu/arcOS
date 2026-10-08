import { describe, expect, it } from "vitest";
import { STALE_AFTER_MS, ageText, checksText, isStale, liquidityText, sourceLabel, utcText } from "../format";

const NOW = 1_790_000_000_000;

describe("ageText", () => {
  it("says just now under a minute, then minutes, hours up to two days, then days", () => {
    expect(ageText(NOW - 59_000, NOW)).toBe("just now");
    expect(ageText(NOW - 60_000, NOW)).toBe("1 min ago");
    expect(ageText(NOW - 59 * 60_000, NOW)).toBe("59 min ago");
    expect(ageText(NOW - 60 * 60_000, NOW)).toBe("1 h ago");
    expect(ageText(NOW - 47 * 3_600_000, NOW)).toBe("47 h ago");
    expect(ageText(NOW - 48 * 3_600_000, NOW)).toBe("2 d ago");
    expect(ageText(NOW - 10 * 86_400_000, NOW)).toBe("10 d ago");
  });

  it("reads a time after now as just now", () => {
    expect(ageText(NOW + 5_000, NOW)).toBe("just now");
  });
});

describe("utcText", () => {
  it("writes the date and the minute in UTC", () => {
    expect(utcText(Date.UTC(2026, 9, 8, 11, 58, 42))).toBe("2026-10-08 11:58 UTC");
  });
});

describe("checksText", () => {
  it("counts the checks, or says the token isn't checked yet", () => {
    expect(checksText(6, 9)).toBe("6 of 9 checks pass");
    expect(checksText(0, 9)).toBe("0 of 9 checks pass");
    expect(checksText(null, null)).toBe("Not checked yet");
    expect(checksText(6, null)).toBe("Not checked yet");
    expect(checksText(null, 9)).toBe("Not checked yet");
  });
});

describe("liquidityText", () => {
  it("rounds a depth down to whole USDC, with a floor and a cap", () => {
    expect(liquidityText("0")).toBe("Under 1 USDC");
    expect(liquidityText("999999")).toBe("Under 1 USDC");
    expect(liquidityText("1000000")).toBe("1 USDC");
    expect(liquidityText("2500000000")).toBe("2,500 USDC");
    expect(liquidityText("999999999999999")).toBe("999,999,999 USDC");
    expect(liquidityText("1000000000000000")).toBe("1B+ USDC");
    expect(liquidityText("9".repeat(78))).toBe("1B+ USDC");
  });
});

describe("sourceLabel", () => {
  it("names each of the five sources", () => {
    expect(sourceLabel("factory")).toBe("4rc.OS");
    expect(sourceLabel("v2")).toBe("Uniswap v2");
    expect(sourceLabel("v3")).toBe("Uniswap v3");
    expect(sourceLabel("v4")).toBe("Uniswap v4");
    expect(sourceLabel("aero")).toBe("Aerodrome");
  });
});

describe("isStale", () => {
  it("is stale past ten minutes, and when no run was reported", () => {
    expect(STALE_AFTER_MS).toBe(600_000);
    expect(isStale(NOW - STALE_AFTER_MS, NOW)).toBe(false);
    expect(isStale(NOW - STALE_AFTER_MS - 1, NOW)).toBe(true);
    expect(isStale(null, NOW)).toBe(true);
    expect(isStale(NOW, NOW)).toBe(false);
  });
});
