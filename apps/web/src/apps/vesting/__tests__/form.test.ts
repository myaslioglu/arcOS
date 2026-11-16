import { describe, expect, it } from "vitest";
import { EMPTY_FORM, MAX_BULK_ROWS, buildPlan, readAmount, type FormState } from "../form";
import { rowsText } from "../form-text";
import { MAX_AMOUNT } from "../schedule";

const TOKEN = "0x2222222222222222222222222222222222222222";
const A = "0x1111111111111111111111111111111111111111";
const B = "0x3333333333333333333333333333333333333333";
const NOW = 1_800_000_000n;
const base: FormState = { ...EMPTY_FORM, token: TOKEN, beneficiary: A, amount: "1000", durationValue: "12", durationUnit: "weeks", cliffValue: "4", cliffUnit: "weeks" };

describe("buildPlan, one beneficiary", () => {
  it("turns a good form into one row and the terms in seconds", () => {
    const plan = buildPlan(base, 18, NOW);
    expect(plan.ok).toBe(true);
    expect(plan.rows).toEqual([{ line: 1, address: A, amount: 1000n * 10n ** 18n }]);
    expect(plan.total).toBe(1000n * 10n ** 18n);
    expect(plan.terms).toEqual({ start: NOW, duration: 12n * 604_800n, cliff: 4n * 604_800n });
    expect(plan.blocker).toBeNull();
  });
  it("reads the amount at the token's decimals", () => {
    expect(buildPlan({ ...base, amount: "1.5" }, 6, NOW).rows[0].amount).toBe(1_500_000n);
  });
  it("waits for the token's decimals", () => {
    const plan = buildPlan(base, null, NOW);
    expect(plan.ok).toBe(false);
    expect(plan.blocker).toBe("Reading the token…");
  });
  it("names the first thing to fix, token first", () => {
    expect(buildPlan({ ...base, token: "" }, null, NOW).blocker).toBe("Choose a token.");
    expect(buildPlan({ ...base, beneficiary: "0x1" }, 18, NOW).blocker).toMatch(/isn't an address/);
    expect(buildPlan({ ...base, amount: "" }, 18, NOW).blocker).toBe("Enter an amount.");
    expect(buildPlan({ ...base, amount: "0" }, 18, NOW).blocker).toMatch(/more than zero/);
    expect(buildPlan({ ...base, amount: "abc" }, 18, NOW).ok).toBe(false);
  });
  it("refuses an amount above the factory's maximum", () => {
    const tooBig = (MAX_AMOUNT + 1n).toString();
    expect(buildPlan({ ...base, amount: tooBig }, 0, NOW).errors.amount).toMatch(/too large/);
    expect(buildPlan({ ...base, amount: MAX_AMOUNT.toString() }, 0, NOW).ok).toBe(true);
  });
  it("refuses a cliff longer than the duration and a duration over 10 years", () => {
    expect(buildPlan({ ...base, cliffValue: "13" }, 18, NOW).errors.cliff).toMatch(/longer than the duration/);
    expect(buildPlan({ ...base, durationValue: "11", durationUnit: "years" }, 18, NOW).errors.duration).toMatch(/10 years/);
    expect(buildPlan({ ...base, durationValue: "10", durationUnit: "years", cliffValue: "" }, 18, NOW).ok).toBe(true);
    expect(buildPlan({ ...base, durationValue: "" }, 18, NOW).errors.duration).toMatch(/how long/);
  });
  it("takes a start in the past and refuses one more than 10 years ahead", () => {
    expect(buildPlan({ ...base, startMode: "date", startDate: "2020-01-01T00:00" }, 18, NOW).ok).toBe(true);
    expect(buildPlan({ ...base, startMode: "date", startDate: "2040-01-01T00:00" }, 18, NOW).errors.start).toMatch(/10 years/);
    expect(buildPlan({ ...base, startMode: "date", startDate: "" }, 18, NOW).errors.start).toMatch(/Choose when/);
  });
});

describe("buildPlan, a list", () => {
  const many: FormState = { ...base, mode: "many", list: `${A},100\n${B},250.5` };
  it("makes one row per line and totals them", () => {
    const plan = buildPlan(many, 18, NOW);
    expect(plan.ok).toBe(true);
    expect(plan.rows.map((r) => r.line)).toEqual([1, 2]);
    expect(plan.total).toBe(3505n * 10n ** 17n);
  });
  it("leaves out bad rows and says why, but still sends the good ones", () => {
    const plan = buildPlan({ ...many, list: `${A},100\nnope,5\n${A},7` }, 18, NOW);
    expect(plan.ok).toBe(true);
    expect(plan.rows).toHaveLength(1);
    expect(plan.issues.map((i) => i.line)).toEqual([2, 3]);
  });
  it("leaves out a row above the factory's maximum", () => {
    const plan = buildPlan({ ...many, list: `${A},1\n${B},${(MAX_AMOUNT + 1n).toString()}` }, 0, NOW);
    expect(plan.rows).toHaveLength(1);
    expect(plan.issues[0].message).toMatch(/too large/);
  });
  it("blocks an ambiguous amount rather than guess", () => {
    const plan = buildPlan({ ...many, list: `${A};1,500` }, 18, NOW);
    expect(plan.ok).toBe(false);
    expect(plan.rows).toEqual([]);
    expect(plan.errors.list).toMatch(/two ways/);
  });
  it("asks for rows when the list is empty or has none usable", () => {
    expect(buildPlan({ ...many, list: "" }, 18, NOW).errors.list).toMatch(/one beneficiary and amount per line/i);
    expect(buildPlan({ ...many, list: "nope,5" }, 18, NOW).errors.list).toMatch(/No row/);
  });
  it("caps a run", () => {
    const addr = (i: number) => `0x${i.toString(16).padStart(40, "0")}`;
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `${addr(i + 1)},1`).join("\n");
    expect(buildPlan({ ...many, list: lines(MAX_BULK_ROWS) }, 18, NOW).ok).toBe(true);
    const over = buildPlan({ ...many, list: lines(MAX_BULK_ROWS + 1) }, 18, NOW);
    expect(over.ok).toBe(false);
    expect(over.errors.list).toMatch(/at most 50/);
    expect(over.rows).toEqual([]);
  });
});

describe("readAmount and rowsText", () => {
  it("reads an amount or says why not, and treats empty as not yet typed", () => {
    expect(readAmount("", 18)).toEqual({ amount: null, error: null });
    expect(readAmount("2.5", 6)).toEqual({ amount: 2_500_000n, error: null });
    expect(readAmount("1.1234567", 6).error).not.toBeNull();
    expect(readAmount("zzz", 6).amount).toBeNull();
  });
  it("writes rows back so they read to the same amounts", () => {
    const rows = [{ line: 4, address: A as `0x${string}`, amount: 1_234_500_000_000_000_000_000n }];
    const text = rowsText(rows, 18);
    expect(text).toBe(`${A},1234.5`);
    const plan = buildPlan({ ...base, mode: "many", list: text }, 18, NOW);
    expect(plan.rows[0].amount).toBe(rows[0].amount);
  });
});
