import { describe, expect, it } from "vitest";
import { ageText, numberText, sinceText } from "../format";

describe("numberText", () => {
  it("separates thousands the same way in every locale", () => {
    expect(numberText(0)).toBe("0");
    expect(numberText(999)).toBe("999");
    expect(numberText(1234)).toBe("1,234");
    expect(numberText(12_345_678)).toBe("12,345,678");
  });
});

describe("sinceText", () => {
  it("writes a UTC date as 'since 25 Sep 2026', without a leading zero", () => {
    expect(sinceText("2026-09-25")).toBe("since 25 Sep 2026");
    expect(sinceText("2026-10-01")).toBe("since 1 Oct 2026");
    expect(sinceText("2027-01-09")).toBe("since 9 Jan 2027");
  });

  it("says nothing when there is no date, or one that isn't", () => {
    for (const bad of [null, "", "2026-13-01", "2026-9-1", "yesterday"]) expect(sinceText(bad), String(bad)).toBe("");
  });
});

describe("ageText", () => {
  const NOW = Date.parse("2026-11-08T12:00:00Z");
  it("is 'just now' under a minute, then minutes, hours and days, never negative", () => {
    expect(ageText(NOW - 30_000, NOW)).toBe("just now");
    expect(ageText(NOW + 5 * 60_000, NOW)).toBe("just now");
    expect(ageText(NOW - 5 * 60_000, NOW)).toBe("5 min ago");
    expect(ageText(NOW - 3 * 3_600_000, NOW)).toBe("3 h ago");
    expect(ageText(NOW - 3 * 86_400_000, NOW)).toBe("3 d ago");
  });
});
