import { AmountError, USDC, parseTokenAmount } from "@arcos/chain";

/**
 * The New lock and Extend forms' rules, mirrored from the vault contracts (packages/contracts/src/vault). Pure: every
 * time is unix seconds, and `now` is the chain's time (useChainClock), which is what the contracts compare against.
 *
 * - LockVault and PositionVault take an unlock time through `initialize` (when the factory makes the vault) and
 *   `extend`, both through `_requireInWindow`: it must be after `block.timestamp` and at most `MAX_DURATION` (3650
 *   days) after it, else `BadUnlockTime`. It is a uint64.
 * - `extend` also needs a time later than the current `unlockAt` (`newUnlockAt <= unlockAt` reverts). On a lock that
 *   has expired the window still applies: the new time must be in the future.
 * - There is no minimum lock length beyond "after now".
 * - `lockToken` refuses a zero amount (`ZeroAmount`); the amount is a uint256 of the token's own units.
 */

export const DAY = 86_400;
/** LockVault.MAX_DURATION and PositionVault.MAX_DURATION: 3650 days, in seconds. */
export const MAX_DURATION = 3650 * DAY;
export const UINT64_MAX = 2n ** 64n - 1n;
/** The New lock form's presets, in days. */
export const PRESET_DAYS = [30, 90, 180, 365] as const;

export const UNLOCK_ERRORS = {
  missing: "Pick an unlock date.",
  past: "The unlock date must be in the future.",
  tooFar: "The unlock date can be at most 10 years from now.",
  notLater: "The new unlock date must be later than the current one.",
} as const;

export type UnlockCheck = { ok: true; unlockAt: number } | { ok: false; error: string };

/** `_requireInWindow`, exactly: `now < unlockAt <= now + MAX_DURATION`, and a whole uint64. */
export function checkUnlock(unlockAt: number | null, now: number): UnlockCheck {
  if (unlockAt === null || !Number.isSafeInteger(unlockAt) || unlockAt < 0 || BigInt(unlockAt) > UINT64_MAX) {
    return { ok: false, error: UNLOCK_ERRORS.missing };
  }
  if (unlockAt <= now) return { ok: false, error: UNLOCK_ERRORS.past };
  if (unlockAt > now + MAX_DURATION) return { ok: false, error: UNLOCK_ERRORS.tooFar };
  return { ok: true, unlockAt };
}

/** `extend`, exactly: later than the current unlock time, then the same window as a new lock. */
export function checkExtend(newUnlockAt: number | null, current: number, now: number): UnlockCheck {
  if (newUnlockAt !== null && Number.isSafeInteger(newUnlockAt) && newUnlockAt <= current) {
    return { ok: false, error: UNLOCK_ERRORS.notLater };
  }
  return checkUnlock(newUnlockAt, now);
}

/** A preset's unlock time: `days` whole days after `from`. */
export function presetUnlock(from: number, days: number): number {
  return from + days * DAY;
}

/** What an Extend preset adds to: the current unlock time, or now once that has passed (an expired lock re-locks). */
export function extendBase(current: number, now: number): number {
  return Math.max(current, now);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A time's day in the local calendar, as a date input's value ("2027-02-16"). */
export function dateValue(seconds: number): string {
  const d = new Date(seconds * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * A date input's value as an unlock time: that day at the local time of day `now` has, so that a date 30 days out
 * unlocks when the 30-day preset would. Null for anything that isn't a real date.
 */
export function unlockFromDate(value: string, now: number): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const [y, mo, day] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const t = new Date(now * 1000);
  const d = new Date(y, mo, day, t.getHours(), t.getMinutes(), t.getSeconds());
  if (d.getFullYear() !== y || d.getMonth() !== mo || d.getDate() !== day) return null;
  return Math.floor(d.getTime() / 1000);
}

/** The day before or after `value`, as a date input's value. */
function shiftDay(value: string, days: number): string {
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const next = new Date(y, m - 1, d + days, 12);
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`;
}

/**
 * The first and last days the date picker offers: the earliest day whose unlock time (see `unlockFromDate`) is after
 * `after` and after now, and the latest still within MAX_DURATION of now. For a new lock `after` is now; for Extend it
 * is the current unlock time. Each bound is checked with `checkExtend`, so a daylight-saving shift between now and the
 * bound can't put the offered day out of the contract's window.
 */
export function dateBounds(now: number, after: number = now): { min: string; max: string } {
  const allowed = (value: string) => checkExtend(unlockFromDate(value, now), after, now).ok;
  let min = dateValue(Math.max(after, now));
  for (let i = 0; i < 3 && !allowed(min); i++) min = shiftDay(min, 1);
  let max = dateValue(now + MAX_DURATION);
  for (let i = 0; i < 3 && !allowed(max); i++) max = shiftDay(max, -1);
  return { min, max };
}

export type AmountCheck = { ok: true; units: bigint } | { ok: false; error: string };

/** An ERC-20 lock's amount: a number in the token's own decimals, more than zero, and no more than the balance. */
export function checkAmount(text: string, decimals: number, balance: bigint | undefined): AmountCheck {
  if (text.trim() === "") return { ok: false, error: "Enter an amount." };
  let units: bigint;
  try {
    units = parseTokenAmount(text, decimals);
  } catch (e) {
    return { ok: false, error: e instanceof AmountError ? e.message : "Enter a number." };
  }
  if (units === 0n) return { ok: false, error: "The amount must be more than zero." };
  if (balance !== undefined && units > balance) return { ok: false, error: "That's more than your balance." };
  return { ok: true, units };
}

/**
 * `lockToken` on a Uniswap v2 LP token: the fee is `floor(amount * bps / 10_000)` and goes to ArcOS's fee recipient,
 * and the vault receives the rest. Any other token pays the flat fee alone: its whole amount reaches the vault.
 */
export function lpSplit(amount: bigint, bps: bigint): { fee: bigint; toVault: bigint } {
  const fee = (amount * bps) / 10_000n;
  return { fee, toVault: amount - fee };
}

/** USDC at 6 decimals that "Max" leaves for gas when the token locked is Arc's USDC itself (the ERC-20 view). */
export const USDC_GAS_RESERVE = 50_000n;

/**
 * What "Max" leaves in the wallet, in the token's units: nothing, except for Arc's USDC (`0x3600…`), whose ERC-20
 * balance is the native balance that also pays the lock's flat fee (18-decimal `flatFee`, rounded up to 6 decimals)
 * and the gas.
 */
export function lockReserve(token: string, flatFee: bigint | undefined): bigint {
  if (token.toLowerCase() !== USDC.toLowerCase()) return 0n;
  const feeUnits = flatFee === undefined ? 0n : (flatFee + 10n ** 12n - 1n) / 10n ** 12n;
  return feeUnits + USDC_GAS_RESERVE;
}

/** "Feb 16, 2027, 2:30 PM", in the visitor's time zone unless one is given (tests pass "UTC"). */
export function formatWhen(seconds: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", ...(timeZone ? { timeZone } : {}) }).format(
    new Date(seconds * 1000),
  );
}

/** "in 92 days", "in 5 hours", "in 3 minutes", or "now": how long until `at`. */
export function untilText(at: number, now: number): string {
  const left = at - now;
  if (left <= 0) return "now";
  const plural = (n: number, unit: string) => `in ${n} ${unit}${n === 1 ? "" : "s"}`;
  if (left >= 2 * DAY) return plural(Math.floor(left / DAY), "day");
  if (left >= 2 * 3600) return plural(Math.floor(left / 3600), "hour");
  return plural(Math.max(1, Math.ceil(left / 60)), "minute");
}
