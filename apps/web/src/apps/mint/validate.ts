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

/** Half of a UTF-16 surrogate pair on its own. TextEncoder (and viem, which uses it) sends U+FFFD in its place. */
const LONE_SURROGATE = /\p{Surrogate}/u;

/**
 * The code points TokenFactory refuses in a name: the controls U+0000-U+001F and U+007F-U+009F, the bidirectional
 * controls U+061C, U+200E, U+200F, U+202A-U+202E and U+2066-U+2069, the line and paragraph separators U+2028 and
 * U+2029, and the invisible spaces U+200B, U+2060 and U+FEFF.
 */
const isBannedInName = (cp: number) =>
  cp < 0x20 ||
  (cp >= 0x7f && cp <= 0x9f) ||
  cp === 0x061c ||
  cp === 0x200e ||
  cp === 0x200f ||
  (cp >= 0x2028 && cp <= 0x202e) ||
  (cp >= 0x2066 && cp <= 0x2069) ||
  cp === 0x200b ||
  cp === 0x2060 ||
  cp === 0xfeff;

/**
 * Mirrors TokenFactory's `_validateName` on the bytes a name is sent as: 1-64 bytes of well-formed UTF-8 (Unicode
 * Table 3-7), no space (0x20) as the first or last byte, and no banned code point. The contract's tests and this
 * one's read the same cases (packages/contracts/test/vectors/names.json).
 */
export function isValidNameBytes(b: Uint8Array): boolean {
  if (b.length === 0 || b.length > 64 || b[0] === 0x20 || b[b.length - 1] === 0x20) return false;
  for (let i = 0; i < b.length; ) {
    const lead = b[i];
    // The sequence's length, and the range Table 3-7 allows for its second byte (every later byte is 80-BF).
    let size: number, lo: number, hi: number;
    if (lead < 0x80) [size, lo, hi] = [1, 0, 0];
    else if (lead < 0xc2) return false; // 80-BF only continue a character; C0 and C1 could only start an overlong form
    else if (lead < 0xe0) [size, lo, hi] = [2, 0x80, 0xbf];
    else if (lead < 0xf0) [size, lo, hi] = [3, lead === 0xe0 ? 0xa0 : 0x80, lead === 0xed ? 0x9f : 0xbf];
    else if (lead < 0xf5) [size, lo, hi] = [4, lead === 0xf0 ? 0x90 : 0x80, lead === 0xf4 ? 0x8f : 0xbf];
    else return false; // F5-FF could only start a value above U+10FFFF
    if (i + size > b.length) return false;
    let cp = size === 1 ? lead : lead & (0x7f >> size);
    for (let k = 1; k < size; k++) {
      const next = b[i + k];
      if (k === 1 ? next < lo || next > hi : next < 0x80 || next > 0xbf) return false;
      cp = (cp << 6) | (next & 0x3f);
    }
    if (isBannedInName(cp)) return false;
    i += size;
  }
  return true;
}

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
  else if (LONE_SURROGATE.test(name)) errors.name = "A name can't contain a broken character, such as half of an emoji";
  // "bytes", not "characters": the contract's _validateName counts UTF-8 bytes, and byteLength()
  // above mirrors that — an accented letter or emoji is 1 JS "character" but 2-4 bytes, so a string
  // that reads as short can still hit this limit well before its character count would suggest.
  else if (byteLength(name) > 64) errors.name = "At most 64 bytes (accented letters and emoji count as more than one)";
  // What's left for the contract's rule to refuse is a banned code point: a trimmed name has no space at either
  // end, and TextEncoder writes well-formed UTF-8 once there's no lone surrogate.
  else if (!isValidNameBytes(new TextEncoder().encode(name))) errors.name = "A name can't contain control, invisible or text-direction characters";
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
