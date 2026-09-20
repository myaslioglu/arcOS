import { AmountError, parseTokenAmount, USDC_DECIMALS } from "@arcos/chain";

/** Validation message for an amount box, or null when there's nothing to complain about (including
 * an empty box — no error before the user has typed anything). `decimals` defaults to USDC/EURC's 6
 * places; pass a token's own decimals (cirBTC is 8) so the message reports the right count instead
 * of always assuming 6. Uses parseTokenAmount's own rules: a comma is only ever a thousands
 * separator, never a decimal point. */
export function amountIssue(text: string, decimals: number = USDC_DECIMALS): string | null {
  if (text.trim() === "") return null;
  try {
    const units = parseTokenAmount(text, decimals);
    return units === 0n ? "Amount must be more than zero" : null;
  } catch (e) {
    return e instanceof AmountError ? e.message : "Enter a number";
  }
}

/** The amount as a comma-free canonical decimal string at the token's own `decimals` (what the SDK
 * expects), or null when the text doesn't parse to a positive amount. Defaults to 6 places
 * (USDC/EURC); pass 8 for cirBTC. */
export function normalizedAmount(text: string, decimals: number = USDC_DECIMALS): string | null {
  try {
    const units = parseTokenAmount(text, decimals);
    return units > 0n ? formatTokenAmount(units, decimals) : null;
  } catch {
    return null;
  }
}

/** Integer token units → display string at `decimals` places, trailing zeros trimmed. Generic
 * counterpart to @arcos/chain's `formatUsdc`, which is hardcoded to USDC's 6-decimal, native-wei
 * round trip and so can't represent cirBTC's 8 decimal places. */
function formatTokenAmount(units: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = units / base;
  const frac = (units % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
