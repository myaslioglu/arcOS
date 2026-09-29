import { DataError } from "./errors";

/**
 * An amount as stored: a non-negative integer in the token's base units, as decimal digits. Firestore numbers are
 * doubles and lose digits above 2^53, so no amount is ever stored as a number.
 */
export type Amount = string;

const UINT256_MAX = 2n ** 256n - 1n;
const UINT256_DIGITS = UINT256_MAX.toString().length;
const CANONICAL = /^(0|[1-9][0-9]*)$/;
const REFUSED = "Not an amount: expected a whole number from 0 to 2^256 - 1";

export function amountToString(value: bigint): Amount {
  if (typeof value !== "bigint" || value < 0n || value > UINT256_MAX) throw new DataError("amount", REFUSED);
  return value.toString();
}

/** Reads an amount back. Only canonical digits pass, and a string longer than uint256 can be is refused before BigInt sees it. */
export function amountFromString(text: Amount): bigint {
  if (typeof text !== "string" || text.length > UINT256_DIGITS || !CANONICAL.test(text)) {
    throw new DataError("amount", REFUSED);
  }
  const value = BigInt(text);
  if (value > UINT256_MAX) throw new DataError("amount", REFUSED);
  return value;
}
