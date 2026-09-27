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

/** Exactly three digits after a lone comma, with 1-3 before it and NOT starting with 0, is the one
 * shape neither rule can read safely: a thousands group ("1,500" meaning 1500) and a decimal comma
 * ("1,500" meaning 1.5) are both plausible, and they're 1000x apart. Four or more digits before it
 * rules the thousands reading out on its own — no group leads with 4+ digits — and a leading 0 does
 * too, for the same reason — no group leads with 0 either — so both shapes (e.g. "1000,000" and
 * "0,250") are read as a decimal comma below instead of ever reaching this check. */
function isAmbiguousGrouping(before: string, after: string): boolean {
  return after.length === 3 && before.length <= 3 && before[0] !== "0";
}

/** The text as it appears inside an error message: the TRIMMED input (never the raw text, so
 * surrounding whitespace, an NBSP or a BOM never shows up inside the quotes), capped at 24 Unicode
 * CODE POINTS plus "…" so pasting a megabyte into the box doesn't echo a megabyte back. `Array.from`
 * splits by code point, not UTF-16 unit, so the cut never lands inside a surrogate pair — a plain
 * `.slice(0, 24)` on a run of emoji can leave a lone surrogate, which renders as "�" (Rm4). */
function quoted(trimmedText: string): string {
  const codePoints = Array.from(trimmedText);
  return codePoints.length > 24 ? `${codePoints.slice(0, 24).join("")}…` : trimmedText;
}

/** Builds the ambiguous-comma message from the same digits both readings come from: the thousands
 * reading just drops the comma, and the decimal reading turns it into a dot and trims trailing
 * zeros, so "0,250" (not itself ambiguous, see above, but the same digit math) would read "could
 * mean 250 or 0.25". When trimming leaves no fractional digits at all — a round thousand, e.g.
 * "5,000" — the decimal reading is a whole number, and "with a dot" is dropped too: `"5,000" could
 * mean 5000 or 5. Write 5000 or 5.` */
function ambiguousMessage(trimmed: string, before: string, after: string): string {
  const thousands = BigInt(before + after).toString();
  const wholePart = BigInt(before).toString();
  const fracPart = after.replace(/0+$/, "");
  const decimal = fracPart ? `${wholePart}.${fracPart}` : wholePart;
  const writeAs = fracPart ? `${thousands}, or ${decimal} with a dot` : `${thousands} or ${decimal}`;
  return `"${quoted(trimmed)}" could mean ${thousands} or ${decimal}. Write ${writeAs}.`;
}

/**
 * Parses a human decimal string into an integer of `decimals` places.
 *
 * A comma before a dot, or two or more commas with no dot, is read as a thousands separator, as
 * before ("1,234.5", "1,000,000"). A single comma with no dot is read as a DECIMAL point instead —
 * "1,5" is 1.5 — because that's how many regions, and a phone's comma-only decimal keypad, write a
 * fraction. The one shape that's genuinely unreadable either way — exactly three digits after that
 * lone comma, with 1-3 before it and not starting with 0 ("1,500", "12,345", but not "0,250": no
 * thousands group starts with 0) — is refused as "ambiguous" rather than guessed at: every reading
 * is 1000x off for someone.
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
      throw new AmountError("ambiguous", ambiguousMessage(trimmed, before, after));
    }
    shaped = `${before}.${after}`;
  }

  if (!SHAPE.test(shaped)) throw new AmountError("format", `"${quoted(trimmed)}" isn't a number`);
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

/** True when `text`, once trimmed, has exactly one comma and no dot — the shape
 * `parseTokenAmount` reads as a decimal comma, or refuses as ambiguous. Exported for Drop
 * (`apps/web/src/apps/drop/parse.ts`), which refuses this shape outright right after a
 * comma-separated address: there, the same comma could just as easily be a third CSV column, and
 * the row can't tell which. */
export function hasLoneComma(text: string): boolean {
  return ONE_COMMA_NO_DOT.test(text.trim());
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
