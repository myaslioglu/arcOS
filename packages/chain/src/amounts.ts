export const NATIVE_DECIMALS = 18;
export const USDC_DECIMALS = 6;
/** 10^(18-6): one ERC-20 USDC unit expressed in native wei. */
export const DUST_FACTOR = 10n ** 12n;

export type AmountErrorCode = "empty" | "format" | "precision" | "negative" | "overflow" | "ambiguous";

/** Solidity's `uint256` max — every amount this app sends on-chain (mint supply/cap, a Drop row,
 * a fee) is eventually encoded as one, so a value that overflows it must be rejected here, in the
 * one shared parser, rather than let a value the ABI encoder can't represent reach the wallet. */
const UINT256_MAX = 2n ** 256n - 1n;

export class AmountError extends Error {
  constructor(
    public readonly code: AmountErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AmountError";
  }
}

const SHAPE = /^(\d+|\d{1,3}(,\d{3})+)(\.\d+)?$/;

/** Matches a string with exactly one comma and no dot, e.g. "1,5" or "1000,000" — the only shape
 * where what a lone comma means (a decimal point, or a thousands group) needs its own read. Two or
 * more commas, or a comma anywhere alongside a dot, never match this — `\d+` can't include a comma
 * or a dot — so they fall straight through to `SHAPE` unchanged, and today's thousands-grouping
 * behavior is untouched. */
const ONE_COMMA_NO_DOT = /^(\d+),(\d+)$/;

/** Exactly three digits after a lone comma, with only 1-3 before it, is the one shape neither rule
 * can read safely: a thousands group ("1,500" meaning 1500) and a decimal comma ("1,500" meaning
 * 1.5) are both plausible, and they're 1000x apart. Four or more digits before it rules the
 * thousands reading out on its own — no group leads with 4+ digits — so that shape (e.g.
 * "1000,000") is read as a decimal comma below instead of ever reaching this check. */
function isAmbiguousGrouping(before: string, after: string): boolean {
  return after.length === 3 && before.length <= 3;
}

/** Builds the ambiguous-comma message, e.g. `"1,500" could mean 1500 or 1.5. Write 1500, or 1.5
 * with a dot.` Both readings come from the same digits: the thousands reading just drops the comma,
 * and the decimal reading trims trailing zeros off the digits after it, so "0,250" reads as "0.25",
 * not "0.250". */
function ambiguousMessage(text: string, before: string, after: string): string {
  const thousands = BigInt(before + after).toString();
  const wholePart = BigInt(before).toString();
  const fracPart = after.replace(/0+$/, "");
  const decimal = fracPart ? `${wholePart}.${fracPart}` : wholePart;
  return `"${text}" could mean ${thousands} or ${decimal}. Write ${thousands}, or ${decimal} with a dot.`;
}

/**
 * Parses a human decimal string into an integer of `decimals` places.
 *
 * A comma before a dot, or two or more commas with no dot, is read as a thousands separator, as
 * before ("1,234.5", "1,000,000"). A single comma with no dot is read as a DECIMAL point instead —
 * "1,5" is 1.5 — because that's how many regions, and a phone's comma-only decimal keypad, write a
 * fraction. The one shape that's genuinely unreadable either way — exactly three digits after that
 * lone comma, with only 1-3 before it ("1,500", "12,345") — is refused as "ambiguous" rather than
 * guessed at: every reading is 1000x off for someone.
 */
export function parseTokenAmount(text: string, decimals: number): bigint {
  const trimmed = text.trim();
  if (trimmed === "") throw new AmountError("empty", "Enter an amount");
  if (trimmed.startsWith("-")) throw new AmountError("negative", "Amount can't be negative");

  // Decided on the trimmed text, before the format/precision/overflow checks below — a decimal
  // comma turned into a dot here then flows through the exact same checks a typed dot would.
  const oneComma = ONE_COMMA_NO_DOT.exec(trimmed);
  let shaped = trimmed;
  if (oneComma) {
    const [, before = "", after = ""] = oneComma;
    if (isAmbiguousGrouping(before, after)) {
      throw new AmountError("ambiguous", ambiguousMessage(text, before, after));
    }
    shaped = `${before}.${after}`;
  }

  if (!SHAPE.test(shaped)) throw new AmountError("format", `"${text}" isn't a number`);
  const raw = shaped.replace(/,/g, "");
  const [whole = "0", frac = ""] = raw.split(".");
  if (frac.length > decimals) {
    throw new AmountError("precision", `At most ${decimals} decimal places`);
  }
  const value = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  // Checked AFTER scaling: a value that looks small as typed can still overflow once multiplied out
  // by `decimals` (e.g. a huge whole number at 18 decimals).
  if (value > UINT256_MAX) throw new AmountError("overflow", "That number is too large.");
  return value;
}

/**
 * USDC as typed by a person → native wei (18 decimals). Input is capped at 6
 * decimal places so the native view and the ERC-20 view always agree.
 */
export function parseUsdc(text: string): bigint {
  return unitsToNative(parseTokenAmount(text, USDC_DECIMALS));
}

export function unitsToNative(units: bigint): bigint {
  return units * DUST_FACTOR;
}

/** Splits native wei into whole ERC-20 units and the sub-unit remainder. */
export function nativeToUnits(wei: bigint): { units: bigint; dust: bigint } {
  return { units: wei / DUST_FACTOR, dust: wei % DUST_FACTOR };
}

/** Native wei → display string, floored to 6 places, trailing zeros trimmed. */
export function formatUsdc(wei: bigint): string {
  const { units } = nativeToUnits(wei);
  const whole = units / 10n ** BigInt(USDC_DECIMALS);
  const frac = (units % 10n ** BigInt(USDC_DECIMALS)).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
