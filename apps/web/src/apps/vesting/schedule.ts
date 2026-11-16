import { isAddress } from "viem";

/**
 * The rules of a vesting schedule, copied from VestingFactory.createVesting and OpenZeppelin's VestingWalletCliff
 * (packages/contracts/src/vesting). Pure: no React, no chain access. test/vectors/vesting.json holds what the real
 * contract reports for a grid of schedules, and __tests__/schedule.test.ts holds `schedulePreview` to every case.
 */

/** VestingFactory.MAX_DURATION: 3650 days, in seconds. */
export const MAX_DURATION = 3650n * 86_400n;
/** VestingFactory.MAX_AMOUNT: `type(uint256).max / MAX_DURATION`, so `total * elapsed` can't overflow. */
export const MAX_AMOUNT = (2n ** 256n - 1n) / MAX_DURATION;

const ZERO = /^0x0{40}$/;

/**
 * What VestingWalletCliff.vestedAmount reports for a wallet holding `amount` in total (its balance plus what it has
 * released): nothing before `start + cliff`, everything from `start + duration`, and between them
 * `amount * (at - start) / duration`, rounded down. `cliff` counts from `start`. All values are seconds, or the
 * token's smallest units. The cliff only delays the release: once it has passed, the line is the one that began at
 * `start`, so the amount that unlocks at the cliff is what the line has reached by then.
 */
export function schedulePreview(amount: bigint, start: bigint, duration: bigint, cliff: bigint, at: bigint): bigint {
  if (at < start + cliff) return 0n;
  if (at < start) return 0n;
  if (at >= start + duration) return amount;
  return (amount * (at - start)) / duration;
}

export type CurvePoint = {
  /** Where on the schedule, 0 at the start and 1 at the end. */
  x: number;
  /** The share vested, 0 to 1. */
  y: number;
};

/**
 * Points for drawing the release curve, from `start` to the end: the start, the moment before the cliff and the cliff
 * itself (so the step shows), evenly spaced points between, and the end. Each `y` is the share of `amount` that
 * `schedulePreview` reports, to four digits.
 */
export function curvePoints(amount: bigint, start: bigint, duration: bigint, cliff: bigint, samples = 48): CurvePoint[] {
  if (duration <= 0n) return [];
  const times = new Set<bigint>([start, start + duration]);
  const cliffAt = start + cliff;
  if (cliff > 0n) {
    times.add(cliffAt - 1n);
    times.add(cliffAt);
  }
  const n = BigInt(Math.max(2, samples));
  for (let i = 1n; i < n; i++) times.add(start + (duration * i) / n);
  return [...times]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((t) => ({
      x: Number(((t - start) * 10_000n) / duration) / 10_000,
      y: amount === 0n ? 0 : Number((schedulePreview(amount, start, duration, cliff, t) * 10_000n) / amount) / 10_000,
    }));
}

export type TermsInput = {
  /** Seconds since the epoch the schedule starts at. */
  start: bigint;
  /** Seconds; null when the field is empty or not a number. */
  duration: bigint | null;
  /** Seconds counted from `start`; null when the field isn't a number. */
  cliff: bigint | null;
  /** The chain's current time, in seconds. */
  now: bigint;
};

export type TermsErrors = Partial<Record<"start" | "duration" | "cliff", string>>;

export const DURATION_ERROR = "Enter how long the schedule runs.";
export const CLIFF_ERROR = "Enter the cliff as a whole number, or leave it at 0.";

/** The factory's `BadSchedule` check: a duration of 1 second to `MAX_DURATION`, a cliff no longer than it, and a start at most `MAX_DURATION` ahead. */
export function validateTerms({ start, duration, cliff, now }: TermsInput): TermsErrors {
  const errors: TermsErrors = {};
  if (duration === null) errors.duration = DURATION_ERROR;
  else if (duration < 1n) errors.duration = "The duration must be at least 1 second.";
  else if (duration > MAX_DURATION) errors.duration = "The duration can be at most 10 years (3,650 days).";
  if (cliff === null) errors.cliff = CLIFF_ERROR;
  else if (duration !== null && duration >= 1n && cliff > duration) errors.cliff = "The cliff can't be longer than the duration.";
  if (start > now + MAX_DURATION) errors.start = "The start can be at most 10 years from now.";
  return errors;
}

/** The factory's `ZeroAmount` and `AmountTooLarge` checks, for one schedule's amount in the token's smallest units. */
export function validateAmount(amount: bigint | null): string | null {
  if (amount === null) return "Enter an amount.";
  if (amount <= 0n) return "The amount must be more than zero.";
  if (amount > MAX_AMOUNT) return "That amount is too large for one schedule.";
  return null;
}

/** An address for the token or the beneficiary: well-formed, and not the zero address (OpenZeppelin refuses it as an owner). */
export function validateAddress(text: string, what: "token" | "beneficiary"): string | null {
  const value = text.trim();
  if (value === "") return what === "token" ? "Choose a token." : "Enter the beneficiary's address.";
  if (!isAddress(value, { strict: false })) return what === "token" ? "That isn't a token address." : "That isn't an address.";
  if (ZERO.test(value)) return what === "token" ? "That isn't a token address." : "The beneficiary can't be the zero address.";
  return null;
}

export type ScheduleInput = TermsInput & {
  token: string;
  beneficiary: string;
  /** In the token's smallest units; null when the field isn't a valid amount. */
  amount: bigint | null;
};

export type ScheduleErrors = TermsErrors & Partial<Record<"token" | "beneficiary" | "amount", string>>;

/** Every limit createVesting enforces, for one schedule. An empty object means the factory would take it. */
export function validateSchedule(input: ScheduleInput): ScheduleErrors {
  const errors: ScheduleErrors = validateTerms(input);
  const token = validateAddress(input.token, "token");
  if (token) errors.token = token;
  const beneficiary = validateAddress(input.beneficiary, "beneficiary");
  if (beneficiary) errors.beneficiary = beneficiary;
  const amount = validateAmount(input.amount);
  if (amount) errors.amount = amount;
  return errors;
}

/**
 * A plain-language note when the schedule has already begun: a start in the past is allowed, and what the line has
 * reached by now is released the moment the schedule is created (once the cliff has passed). Null otherwise.
 */
export function startedNote(start: bigint, duration: bigint, cliff: bigint, now: bigint): string | null {
  if (now < start) return null;
  if (now >= start + duration) return "This schedule has already ended, so the whole amount can be released right away.";
  if (now >= start + cliff) return "This schedule has already started, so part of the amount can be released right away.";
  return "This schedule has already started. Nothing can be released until the cliff passes.";
}
