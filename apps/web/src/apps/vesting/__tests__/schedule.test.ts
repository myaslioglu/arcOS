import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_AMOUNT, MAX_DURATION, curvePoints, schedulePreview, startedNote, validateAddress, validateAmount, validateSchedule, validateTerms } from "../schedule";

type Vector = { amount: string; start: string; duration: string; cliff: string; at: string; vested: string };
const file = JSON.parse(readFileSync(join(import.meta.dirname, "../../../../../../packages/contracts/test/vectors/vesting.json"), "utf8")) as {
  maxDuration: string;
  maxAmount: string;
  cases: Vector[];
};

describe("the contract's own numbers (test/vectors/vesting.json)", () => {
  it("has the factory's limits", () => {
    expect(MAX_DURATION).toBe(BigInt(file.maxDuration));
    expect(MAX_AMOUNT).toBe(BigInt(file.maxAmount));
  });

  it("covers a grid of cases, edges included", () => {
    expect(file.cases.length).toBeGreaterThan(150);
    const has = (f: (v: Vector) => boolean) => file.cases.some(f);
    expect(has((v) => v.amount === "1")).toBe(true); // one wei
    expect(has((v) => v.cliff === "0")).toBe(true);
    expect(has((v) => v.cliff === v.duration)).toBe(true);
    expect(has((v) => BigInt(v.at) === BigInt(v.start) - 1n)).toBe(true);
    expect(has((v) => v.at === v.start)).toBe(true);
    expect(has((v) => BigInt(v.at) === BigInt(v.start) + BigInt(v.cliff) - 1n && v.cliff !== "0")).toBe(true);
    expect(has((v) => BigInt(v.at) === BigInt(v.start) + BigInt(v.cliff))).toBe(true);
    expect(has((v) => BigInt(v.at) === BigInt(v.start) + BigInt(v.duration) - 1n)).toBe(true);
    expect(has((v) => BigInt(v.at) === BigInt(v.start) + BigInt(v.duration))).toBe(true);
    expect(has((v) => v.amount === file.maxAmount)).toBe(true);
    expect(has((v) => BigInt(v.duration) % 2n === 1n && BigInt(v.duration) > 1n)).toBe(true);
  });

  it("matches schedulePreview on every case", () => {
    for (const v of file.cases) {
      const got = schedulePreview(BigInt(v.amount), BigInt(v.start), BigInt(v.duration), BigInt(v.cliff), BigInt(v.at));
      expect(got.toString(), JSON.stringify(v)).toBe(v.vested);
    }
  });
});

describe("schedulePreview", () => {
  it("is nothing before the cliff, linear after it, and everything at the end", () => {
    expect(schedulePreview(1000n, 100n, 100n, 50n, 149n)).toBe(0n);
    expect(schedulePreview(1000n, 100n, 100n, 50n, 150n)).toBe(500n); // the line that began at the start, not a fresh one
    expect(schedulePreview(1000n, 100n, 100n, 50n, 199n)).toBe(990n);
    expect(schedulePreview(1000n, 100n, 100n, 50n, 200n)).toBe(1000n);
    expect(schedulePreview(1000n, 100n, 100n, 50n, 10_000n)).toBe(1000n);
  });

  it("rounds down", () => {
    expect(schedulePreview(7n, 0n, 3n, 0n, 1n)).toBe(2n);
    expect(schedulePreview(7n, 0n, 3n, 0n, 2n)).toBe(4n);
  });
});

describe("curvePoints", () => {
  it("runs from 0 to 1 on both axes, and shows the cliff as a step", () => {
    const p = curvePoints(10_000n, 1000n, 1000n, 400n);
    expect(p[0]).toEqual({ x: 0, y: 0 });
    expect(p[p.length - 1]).toEqual({ x: 1, y: 1 });
    const before = p.find((q) => q.x === 0.399);
    const at = p.find((q) => q.x === 0.4);
    expect(before?.y).toBe(0);
    expect(at?.y).toBe(0.4);
    for (let i = 1; i < p.length; i++) {
      expect(p[i].x).toBeGreaterThan(p[i - 1].x);
      expect(p[i].y).toBeGreaterThanOrEqual(p[i - 1].y);
    }
  });

  it("is flat zero for a zero amount, and empty for no duration", () => {
    expect(curvePoints(0n, 0n, 100n, 0n).every((q) => q.y === 0)).toBe(true);
    expect(curvePoints(5n, 0n, 0n, 0n)).toEqual([]);
  });
});

describe("validateTerms", () => {
  const now = 1_800_000_000n;
  const ok = { start: now, duration: 100n, cliff: 0n, now };
  it("takes a plain schedule, a cliff as long as the duration, a past start and one 10 years ahead", () => {
    expect(validateTerms(ok)).toEqual({});
    expect(validateTerms({ ...ok, cliff: 100n })).toEqual({});
    expect(validateTerms({ ...ok, start: 0n })).toEqual({});
    expect(validateTerms({ ...ok, start: now + MAX_DURATION })).toEqual({});
    expect(validateTerms({ ...ok, duration: MAX_DURATION })).toEqual({});
  });
  it("refuses what the factory reverts BadSchedule for", () => {
    expect(validateTerms({ ...ok, duration: 0n }).duration).toMatch(/at least 1 second/);
    expect(validateTerms({ ...ok, duration: MAX_DURATION + 1n }).duration).toMatch(/10 years/);
    expect(validateTerms({ ...ok, cliff: 101n }).cliff).toMatch(/longer than the duration/);
    expect(validateTerms({ ...ok, start: now + MAX_DURATION + 1n }).start).toMatch(/10 years/);
  });
  it("asks for what is missing", () => {
    expect(validateTerms({ ...ok, duration: null }).duration).toMatch(/how long/);
    expect(validateTerms({ ...ok, cliff: null }).cliff).toMatch(/whole number/);
  });
});

describe("validateAmount and validateAddress", () => {
  it("mirrors ZeroAmount and AmountTooLarge", () => {
    expect(validateAmount(1n)).toBeNull();
    expect(validateAmount(MAX_AMOUNT)).toBeNull();
    expect(validateAmount(0n)).toMatch(/more than zero/);
    expect(validateAmount(MAX_AMOUNT + 1n)).toMatch(/too large/);
    expect(validateAmount(null)).toMatch(/Enter an amount/);
  });
  it("refuses a malformed or zero address", () => {
    const a = "0x1111111111111111111111111111111111111111";
    expect(validateAddress(a, "token")).toBeNull();
    expect(validateAddress(a, "beneficiary")).toBeNull();
    expect(validateAddress("", "token")).toMatch(/Choose a token/);
    expect(validateAddress("0x12", "beneficiary")).toMatch(/isn't an address/);
    expect(validateAddress("0x0000000000000000000000000000000000000000", "beneficiary")).toMatch(/zero address/);
  });
  it("validateSchedule gathers every field", () => {
    const errors = validateSchedule({ token: "", beneficiary: "x", amount: 0n, start: 0n, duration: 0n, cliff: 1n, now: 1n });
    expect(Object.keys(errors).sort()).toEqual(["amount", "beneficiary", "duration", "token"]);
  });
});

describe("startedNote", () => {
  it("says nothing for a future start, and explains a start in the past", () => {
    expect(startedNote(200n, 100n, 0n, 100n)).toBeNull();
    expect(startedNote(100n, 100n, 50n, 120n)).toMatch(/until the cliff/);
    expect(startedNote(100n, 100n, 0n, 150n)).toMatch(/part of the amount/);
    expect(startedNote(100n, 100n, 0n, 300n)).toMatch(/already ended/);
  });
});
