import { parseTokenAmount } from "@arcos/chain";
import { formatTokenAmount } from "./amount";

/**
 * USDC (in 6-decimal units) that "Max" leaves behind when the token being spent is Arc's own USDC, which is also the
 * gas token there. 0.05 USDC: at Arc's 20 gwei an approval and a swap or a burn together cost around 0.01 USDC, so this
 * covers both with room for a busier block, and the rest of the balance is still offered.
 */
export const ARC_GAS_RESERVE_UNITS = 50_000n;

/** Pure maths for a "Max" button: the most that can be typed into an amount box. */
export type MaxOptions = {
  /** Left untouched for gas when the token spent also pays for gas (USDC on Arc). */
  reserveUnits?: bigint;
  /**
   * A fee in basis points that is added on top of the amount and paid from the same balance (Bridge's platform fee),
   * so `amount + fee(amount)` must still fit.
   */
  feeOnTopBps?: number;
};

/**
 * The largest amount, in the token's own units, whose total (the amount plus any fee on top) fits in `balanceUnits`
 * after the reserve. Never negative: a balance at or below the reserve gives 0.
 *
 * With a fee on top of `bps`, the amount `a` has to satisfy `a + floor(a * bps / 10000) <= spendable`; the floor of
 * `spendable * 10000 / (10000 + bps)` always does, since `a * (10000 + bps) <= spendable * 10000`.
 */
export function maxSpendable(balanceUnits: bigint, { reserveUnits = 0n, feeOnTopBps = 0 }: MaxOptions = {}): bigint {
  const spendable = balanceUnits - reserveUnits;
  if (spendable <= 0n) return 0n;
  if (feeOnTopBps <= 0) return spendable;
  return (spendable * 10_000n) / (10_000n + BigInt(feeOnTopBps));
}

/** The text a "Max" click puts into the amount box: `maxSpendable` as a plain decimal, or null when it is nothing. */
export function maxAmountText(balanceUnits: bigint, decimals: number, options: MaxOptions = {}): string | null {
  const max = maxSpendable(balanceUnits, options);
  return max > 0n ? formatTokenAmount(max, decimals) : null;
}

/** "Balance: 12.5 USDC", the line shown under an amount box. */
export function balanceLabel(balanceUnits: bigint, decimals: number, symbol: string): string {
  return `Balance: ${formatTokenAmount(balanceUnits, decimals)} ${symbol}`;
}

/**
 * The amount box's message when what was typed (plus any fee on top) is more than the balance, else null. Null too while
 * the balance is unknown (not loaded yet, or the read failed) and for text that doesn't parse: `amountIssue` already
 * speaks for that, and the button must not be held back by a read that never came.
 */
export function overBalanceIssue(
  text: string,
  decimals: number,
  balanceUnits: bigint | undefined,
  { feeOnTopBps = 0, where }: { feeOnTopBps?: number; where?: string } = {},
): string | null {
  if (balanceUnits === undefined) return null;
  let units: bigint;
  try {
    units = parseTokenAmount(text, decimals);
  } catch {
    return null;
  }
  if (units <= 0n) return null;
  const total = units + (units * BigInt(feeOnTopBps)) / 10_000n;
  if (total <= balanceUnits) return null;
  const place = where ? ` on ${where}` : "";
  return feeOnTopBps > 0 ? `With the fee, that's more than your balance${place}.` : `That's more than your balance${place}.`;
}
