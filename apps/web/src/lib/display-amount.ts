import { formatTokenAmount } from "./amount";

/**
 * Display-only amounts. Everything here turns an exact decimal into a short string for the eye; none of it may
 * feed an input box, a transaction or an API call (those keep the exact value, see ./amount).
 *
 * Rules, worked on the decimal digits with bigint (no floats, so no binary rounding noise):
 *  - zero is "0";
 *  - 1 or more: at most 2 decimals, rounded half up, trailing zeros dropped, thousands separated by commas
 *    ("2496.490622" -> "2,496.49", "12.5" -> "12.5");
 *  - below 1: 4 significant digits ("0.003725534907" -> "0.003726");
 *  - below 0.0001 but not zero: "< 0.0001", so a fee never reads as free and a balance never as empty.
 *
 * Rounding never flatters: pass `"down"` for what the user receives or is guaranteed (balances, minimum received) so
 * it is never overstated, `"up"` for what they pay (fees, totals) so it is never understated. The default, `"half"`,
 * is for neutral text. "999.999" is "999.99" down, "1,000" up and half; "1.234" is "1.24" up.
 * Text that isn't a plain non-negative decimal ("unknown", "?") comes back unchanged.
 */
export const DUST_FLOOR = "< 0.0001";

export type RoundingMode = "down" | "up" | "half";

const PLAIN_DECIMAL = /^(\d+)(?:\.(\d+))?$/;

function group(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** `n / 10^scale` rounded to `places` decimals in `mode`, as a trimmed decimal string without separators. */
function roundTo(n: bigint, scale: number, places: number, mode: RoundingMode): string {
  let value = n;
  if (scale > places) {
    const drop = 10n ** BigInt(scale - places);
    value = mode === "down" ? n / drop : mode === "up" ? (n + drop - 1n) / drop : (n + drop / 2n) / drop;
  } else if (scale < places) {
    value = n * 10n ** BigInt(places - scale);
  }
  const digits = value.toString().padStart(places + 1, "0");
  const whole = digits.slice(0, digits.length - places);
  const frac = digits.slice(digits.length - places).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

export function displayAmount(text: string, { separators = true, mode = "half" }: { separators?: boolean; mode?: RoundingMode } = {}): string {
  const m = PLAIN_DECIMAL.exec(text.trim());
  if (!m) return text;
  const frac = m[2] ?? "";
  const scale = frac.length;
  const n = BigInt(m[1] + frac);
  if (n === 0n) return "0";
  const one = 10n ** BigInt(scale);
  let out: string;
  if (n >= one) {
    out = roundTo(n, scale, 2, mode);
  } else {
    if (n * 10_000n < one) return DUST_FLOOR;
    // Position of the first non-zero decimal (1-based), then keep 4 significant digits from there.
    const firstNonZero = scale - n.toString().length + 1;
    out = roundTo(n, scale, firstNonZero + 3, mode);
  }
  if (!separators) return out;
  const [whole, rest] = out.split(".");
  return rest ? `${group(whole)}.${rest}` : group(whole);
}

/** Integer token units at `decimals` places (Mint, Drop token rows, ERC-20 balances). */
export function displayUnits(units: bigint, decimals: number, mode: RoundingMode = "half"): string {
  return displayAmount(formatTokenAmount(units, decimals), { mode });
}

/** Native wei of Arc's 18-decimal USDC (balances, Drop's fee quote, Mint's fee), rounded from the exact wei. */
export function displayWei(wei: bigint, mode: RoundingMode = "half"): string {
  return displayAmount(formatTokenAmount(wei, 18), { mode });
}
