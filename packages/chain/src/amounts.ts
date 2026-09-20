export const NATIVE_DECIMALS = 18;
export const USDC_DECIMALS = 6;
/** 10^(18-6): one ERC-20 USDC unit expressed in native wei. */
export const DUST_FACTOR = 10n ** 12n;

export type AmountErrorCode = "empty" | "format" | "precision" | "negative";

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

/** Parses a human decimal string into an integer of `decimals` places. Commas are accepted only as thousands separators, never as decimal points. */
export function parseTokenAmount(text: string, decimals: number): bigint {
  const trimmed = text.trim();
  if (trimmed === "") throw new AmountError("empty", "Enter an amount");
  if (trimmed.startsWith("-")) throw new AmountError("negative", "Amount can't be negative");
  if (!SHAPE.test(trimmed)) throw new AmountError("format", `"${text}" isn't a number`);
  const raw = trimmed.replace(/,/g, "");
  const [whole = "0", frac = ""] = raw.split(".");
  if (frac.length > decimals) {
    throw new AmountError("precision", `At most ${decimals} decimal places`);
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
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
