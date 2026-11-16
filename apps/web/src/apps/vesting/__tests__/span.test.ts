import { describe, expect, it } from "vitest";
import { parseCliff, parseSpan, parseStart, spanText, utcText } from "../span";

describe("parseSpan", () => {
  it("reads whole numbers of each unit, in seconds", () => {
    expect(parseSpan("90", "days")).toBe(7_776_000n);
    expect(parseSpan(" 2 ", "weeks")).toBe(1_209_600n);
    expect(parseSpan("1", "years")).toBe(31_536_000n);
    expect(parseSpan("5", "minutes")).toBe(300n);
    expect(parseSpan("36", "hours")).toBe(129_600n);
  });
  it("refuses a decimal, a sign, text and an empty field", () => {
    for (const t of ["1.5", "1,5", "-1", "abc", "", "  ", "1e3", "1234567890"]) expect(parseSpan(t, "days"), t).toBeNull();
  });
  it("reads an empty cliff as none", () => {
    expect(parseCliff("", "days")).toBe(0n);
    expect(parseCliff("0", "days")).toBe(0n);
    expect(parseCliff("x", "days")).toBeNull();
  });
});

describe("parseStart", () => {
  it("is now, or a date-time", () => {
    expect(parseStart("now", "", 123n)).toBe(123n);
    expect(parseStart("date", "", 123n)).toBeNull();
    expect(parseStart("date", "nonsense", 123n)).toBeNull();
    expect(parseStart("date", "2026-11-16T12:00", 0n)).toBe(BigInt(Math.floor(new Date("2026-11-16T12:00").getTime() / 1000)));
  });
});

describe("spanText and utcText", () => {
  it("uses the largest unit that divides evenly", () => {
    expect(spanText(31_536_000n)).toBe("1 year");
    expect(spanText(63_072_000n)).toBe("2 years");
    expect(spanText(7_776_000n)).toBe("90 days");
    expect(spanText(604_800n)).toBe("1 week");
    expect(spanText(129_600n)).toBe("36 hours");
    expect(spanText(60n)).toBe("1 minute");
    expect(spanText(45n)).toBe("45 seconds");
    expect(spanText(0n)).toBe("0 seconds");
  });
  it("writes a moment in UTC", () => {
    expect(utcText(0n)).toBe("1 Jan 1970, 00:00 UTC");
    expect(utcText(1_800_000_000n)).toBe("15 Jan 2027, 08:00 UTC");
  });
});
