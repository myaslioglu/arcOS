import { formatUsdc } from "@arcos/chain";
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
 * Text that isn't a plain non-negative decimal ("unknown", "?") comes back unchanged.
 */
export const DUST_FLOOR = "< 0.0001";

const PLAIN_DECIMAL = /^(\d+)(?:\.(\d+))?$/;

function group(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** `n / 10^scale` rounded half up to `places` decimals, as a trimmed decimal string without separators. */
function roundTo(n: bigint, scale: number, places: number): string {
  let value = n;
  if (scale > places) {
    const drop = 10n ** BigInt(scale - places);
    value = (n + drop / 2n) / drop;
  } else if (scale < places) {
    value = n * 10n ** BigInt(places - scale);
  }
  const digits = value.toString().padStart(places + 1, "0");
  const whole = digits.slice(0, digits.length - places);
  const frac = digits.slice(digits.length - places).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

export function displayAmount(text: string, { separators = true }: { separators?: boolean } = {}): string {
  const m = PLAIN_DECIMAL.exec(text.trim());
  if (!m) return text;
  const frac = m[2] ?? "";
  const scale = frac.length;
  const n = BigInt(m[1] + frac);
  if (n === 0n) return "0";
  const one = 10n ** BigInt(scale);
  let out: string;
  if (n >= one) {
    out = roundTo(n, scale, 2);
  } else {
    if (n * 10_000n < one) return DUST_FLOOR;
    // Position of the first non-zero decimal (1-based), then keep 4 significant digits from there.
    const firstNonZero = scale - n.toString().length + 1;
    out = roundTo(n, scale, firstNonZero + 3);
  }
  if (!separators) return out;
  const [whole, rest] = out.split(".");
  return rest ? `${group(whole)}.${rest}` : group(whole);
}

/** Integer token units at `decimals` places (Mint, Drop token rows, ERC-20 balances). */
export function displayUnits(units: bigint, decimals: number): string {
  return displayAmount(formatTokenAmount(units, decimals));
}

/** Native wei of Arc's 18-decimal USDC (balances, Drop's fee quote, Mint's fee). */
export function displayWei(wei: bigint): string {
  // formatUsdc floors to 6 places; a nonzero amount below that must still read as dust, not 0.
  return wei > 0n && formatUsdc(wei) === "0" ? DUST_FLOOR : displayAmount(formatUsdc(wei));
}
