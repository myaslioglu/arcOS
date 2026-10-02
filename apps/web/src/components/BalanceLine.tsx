import { balanceLabel, maxAmountText, type MaxOptions } from "@/lib/balance";

export type BalanceLineProps = {
  /** The balance in the token's own units; undefined while it loads or when the read failed (nothing is shown). */
  units: bigint | undefined;
  decimals: number;
  symbol: string;
  /** Appended after the symbol, e.g. "on Base" when the balance is on another chain than Arc. */
  where?: string;
  /** How "Max" is worked out: a reserve for gas, a fee added on top. */
  max?: MaxOptions;
  disabled?: boolean;
  /** Receives the amount text "Max" puts in the box. */
  onMax: (text: string) => void;
};

/**
 * "Balance: 12.5 USDC" under an amount box, with a "Max" button that fills in all of it that can be spent. Renders nothing
 * until a balance is known, so a disconnected wallet or a failed read shows no line rather than a wrong "0".
 */
export function BalanceLine({ units, decimals, symbol, where, max, disabled, onMax }: BalanceLineProps) {
  if (units === undefined) return null;
  const maxText = maxAmountText(units, decimals, max);
  return (
    <span className="mt-1 flex items-center justify-between gap-2 text-xs text-muted">
      <span>
        {balanceLabel(units, decimals, symbol)}
        {where ? ` on ${where}` : ""}
      </span>
      <button
        type="button"
        className="min-h-6 rounded border border-border-2 px-1.5 text-xs pointer-coarse:min-h-9 disabled:opacity-50"
        disabled={disabled || maxText === null}
        onClick={() => maxText !== null && onMax(maxText)}
        aria-label={`Use the maximum amount of ${symbol}`}
      >
        Max
      </button>
    </span>
  );
}
