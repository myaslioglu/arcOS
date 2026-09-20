import { AmountError, formatUsdc, parseUsdc } from "@arcos/chain";

/** Validation message for an amount box, or null when there's nothing to complain about (including
 * an empty box — no error before the user has typed anything). Uses parseUsdc's own rules: a comma
 * is only ever a thousands separator, never a decimal point. */
export function amountIssue(text: string): string | null {
  if (text.trim() === "") return null;
  try {
    const wei = parseUsdc(text);
    return wei === 0n ? "Amount must be more than zero" : null;
  } catch (e) {
    return e instanceof AmountError ? e.message : "Enter a number";
  }
}

/** The amount as a comma-free canonical decimal string (what the SDK expects), or null when the
 * text doesn't parse to a positive amount. */
export function normalizedAmount(text: string): string | null {
  try {
    const wei = parseUsdc(text);
    return wei > 0n ? formatUsdc(wei) : null;
  } catch {
    return null;
  }
}
