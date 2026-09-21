import { describe, expect, it } from "vitest";
import { validateMint, type MintForm } from "../validate";

const HOLDER = "0x1111111111111111111111111111111111111111";
const form = (over: Partial<MintForm> = {}): MintForm => ({
  name: "Duke", symbol: "DUKE", decimals: "18", supply: "1,000,000", mintable: false, burnable: false, cap: "", ...over,
});

describe("validateMint", () => {
  it("builds contract arguments from a valid form", () => {
    expect(validateMint(form(), HOLDER)).toEqual({
      ok: true,
      args: { name: "Duke", symbol: "DUKE", decimals: 18, initialSupply: 1_000_000n * 10n ** 18n, mintable: false, burnable: false, cap: 0n, holder: HOLDER },
    });
  });

  it("trims names and ignores a cap typed on a fixed-supply token", () => {
    const r = validateMint(form({ name: "  Duke ", cap: "5" }), HOLDER);
    expect(r.ok && r.args.name).toBe("Duke");
    expect(r.ok && r.args.cap).toBe(0n);
  });

  it("reports every problem at once", () => {
    const r = validateMint(form({ name: "", symbol: "WAY-TOO-LONG-SYMBOL", decimals: "19", supply: "0" }), HOLDER);
    expect(r).toEqual({
      ok: false,
      errors: {
        name: "Enter a name",
        symbol: "At most 16 bytes (accented letters and emoji count as more than one)",
        decimals: "A whole number from 0 to 18",
        supply: "Supply must be more than zero",
      },
    });
  });

  // Wave E "should fix": the rule TokenFactory enforces (and byteLength() checks) counts UTF-8 BYTES,
  // not JS string "characters" — the old wording said "characters", which understates how few
  // accented letters or emoji actually fit.
  it("says 'bytes', not 'characters', for a too-long name — and explains why that's not the same as string length", () => {
    const tooLong = "x".repeat(65); // 65 plain ASCII bytes — over the 64-byte limit, one char per byte
    expect(validateMint(form({ name: tooLong }), HOLDER)).toEqual({
      ok: false,
      errors: { name: "At most 64 bytes (accented letters and emoji count as more than one)" },
    });
  });

  it("says 'bytes' for a too-long symbol", () => {
    const tooLong = "X".repeat(17); // 17 bytes, over the 16-byte limit
    expect(validateMint(form({ symbol: tooLong }), HOLDER)).toEqual({
      ok: false,
      errors: { symbol: "At most 16 bytes (accented letters and emoji count as more than one)" },
    });
  });

  it("the byte limit bites well before the JS string-length limit for multi-byte text — proving 'characters' would have been misleading", () => {
    // "é" is 1 JS character but 2 UTF-8 bytes — 33 of them is 33 "characters" yet 66 bytes, over the
    // 64-byte name limit despite reading as a short string.
    const accented = "é".repeat(33);
    expect(accented.length).toBe(33);
    expect(validateMint(form({ name: accented }), HOLDER)).toEqual({
      ok: false,
      errors: { name: "At most 64 bytes (accented letters and emoji count as more than one)" },
    });
  });

  it("rejects a cap below the initial supply and respects decimals", () => {
    expect(validateMint(form({ mintable: true, cap: "999" }), HOLDER)).toEqual({ ok: false, errors: { cap: "Cap can't be below the initial supply" } });
    expect(validateMint(form({ decimals: "0", supply: "1.5" }), HOLDER)).toEqual({ ok: false, errors: { supply: "At most 0 decimal places" } });
    const capped = validateMint(form({ mintable: true, cap: "2,000,000" }), HOLDER);
    expect(capped.ok && capped.args.cap).toBe(2_000_000n * 10n ** 18n);
  });

  it("leaves the cap truly empty as uncapped, matching the contract's cap == 0 semantics", () => {
    const empty = validateMint(form({ mintable: true, cap: "" }), HOLDER);
    expect(empty.ok).toBe(true);
    expect(empty.ok && empty.args.cap).toBe(0n);
    const blank = validateMint(form({ mintable: true, cap: "   " }), HOLDER);
    expect(blank.ok).toBe(true);
    expect(blank.ok && blank.args.cap).toBe(0n);
  });

  it("rejects an explicit zero cap instead of silently treating it as uncapped — 0 and empty used to be ambiguous", () => {
    expect(validateMint(form({ mintable: true, cap: "0" }), HOLDER)).toEqual({ ok: false, errors: { cap: "Leave it empty for no cap." } });
    expect(validateMint(form({ mintable: true, cap: "0.0" }), HOLDER)).toEqual({ ok: false, errors: { cap: "Leave it empty for no cap." } });
  });

  it("rejects a cap (or supply) that overflows uint256 once scaled by decimals, with a readable message", () => {
    const hugeCap = validateMint(form({ mintable: true, cap: `1${"0".repeat(60)}` }), HOLDER);
    expect(hugeCap).toEqual({ ok: false, errors: { cap: "That number is too large." } });
    const hugeSupply = validateMint(form({ supply: `1${"0".repeat(60)}` }), HOLDER);
    expect(hugeSupply).toEqual({ ok: false, errors: { supply: "That number is too large." } });
  });

  it("mirrors the factory's content rules", () => {
    expect(validateMint(form({ symbol: "DU KE" }), HOLDER)).toEqual({ ok: false, errors: { symbol: "Use letters, digits and punctuation only — no spaces or accents" } });
    expect(validateMint(form({ symbol: "USDС" }), HOLDER)).toEqual({ ok: false, errors: { symbol: "Use letters, digits and punctuation only — no spaces or accents" } }); // Cyrillic С
    expect(validateMint(form({ name: "Bad\u0001Name" }), HOLDER)).toEqual({ ok: false, errors: { name: "A name can't contain control characters" } });
    expect(validateMint(form({ name: "Türk Lirası" }), HOLDER).ok).toBe(true);
    expect(validateMint(form({ symbol: "USD-T_2.0" }), HOLDER).ok).toBe(true);
  });
});
