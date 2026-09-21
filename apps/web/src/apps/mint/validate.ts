import { AmountError, parseTokenAmount, type Address } from "@arcos/chain";

export type MintForm = { name: string; symbol: string; decimals: string; supply: string; mintable: boolean; burnable: boolean; cap: string };
export type MintArgs = { name: string; symbol: string; decimals: number; initialSupply: bigint; mintable: boolean; burnable: boolean; cap: bigint; holder: Address };
type Errors = Partial<Record<keyof MintForm, string>>;

const amount = (text: string, decimals: number): bigint | string => {
  try {
    return parseTokenAmount(text, decimals);
  } catch (e) {
    return e instanceof AmountError ? e.message : "Enter a number";
  }
};

const byteLength = (s: string) => new TextEncoder().encode(s).length;

/** Mirrors TokenFactory's `_validateName`: every byte must be >= 0x20 and != 0x7F; multi-byte UTF-8 is unrestricted. */
const hasControlByte = (s: string) => {
  for (const b of new TextEncoder().encode(s)) if (b < 0x20 || b === 0x7f) return true;
  return false;
};

/** Mirrors TokenFactory's `_validateSymbol`: every byte must be printable, non-space ASCII (0x21-0x7E). */
const isPrintableAsciiSymbol = (s: string) => {
  for (const b of new TextEncoder().encode(s)) if (b < 0x21 || b > 0x7e) return false;
  return true;
};

export function validateMint(form: MintForm, holder: Address): { ok: true; args: MintArgs } | { ok: false; errors: Errors } {
  const errors: Errors = {};
  const name = form.name.trim();
  const symbol = form.symbol.trim();
  if (name === "") errors.name = "Enter a name";
  // "bytes", not "characters": the contract's _validateName counts UTF-8 bytes, and byteLength()
  // above mirrors that — an accented letter or emoji is 1 JS "character" but 2-4 bytes, so a string
  // that reads as short can still hit this limit well before its character count would suggest.
  else if (byteLength(name) > 64) errors.name = "At most 64 bytes (accented letters and emoji count as more than one)";
  else if (hasControlByte(name)) errors.name = "A name can't contain control characters";
  if (symbol === "") errors.symbol = "Enter a symbol";
  else if (byteLength(symbol) > 16) errors.symbol = "At most 16 bytes (accented letters and emoji count as more than one)";
  else if (!isPrintableAsciiSymbol(symbol)) errors.symbol = "Use letters, digits and punctuation only — no spaces or accents";

  const decimals = /^\d+$/.test(form.decimals.trim()) ? Number(form.decimals) : NaN;
  if (!(decimals >= 0 && decimals <= 18)) errors.decimals = "A whole number from 0 to 18";

  // Keep validating the amounts when decimals is wrong, so the form reports every problem at once.
  const places = errors.decimals ? 18 : decimals;
  let supply = 0n;
  let cap = 0n;
  const s = amount(form.supply, places);
  if (typeof s === "string") errors.supply = s;
  else if (s === 0n) errors.supply = "Supply must be more than zero";
  else supply = s;

  if (form.mintable && form.cap.trim() !== "") {
    const c = amount(form.cap, places);
    if (typeof c === "string") errors.cap = c;
    // An explicit 0 is rejected rather than silently treated as "uncapped": a typed 0 and a truly
    // empty field used to mean the same thing on chain (TokenFactory's cap == 0 => uncapped), which
    // reads as "this token is capped at zero" to anyone who didn't know that convention. Leaving the
    // field empty (the `form.cap.trim() !== ""` guard above) still means uncapped.
    else if (c === 0n) errors.cap = "Leave it empty for no cap.";
    else if (!errors.supply && c < supply) errors.cap = "Cap can't be below the initial supply";
    else cap = c;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, args: { name, symbol, decimals, initialSupply: supply, mintable: form.mintable, burnable: form.burnable, cap, holder } };
}
