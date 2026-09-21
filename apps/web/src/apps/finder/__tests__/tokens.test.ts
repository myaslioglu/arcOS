import { describe, expect, it } from "vitest";
import { EURC, USDC } from "@arcos/chain";
import { cleanLabel } from "@arcos/inspector";
import { duplicateSymbols, latestSliceStart, mergeTokens, officialSymbol, type TokenFile } from "../tokens";

const A = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "0xccccccccccccccccccccccccccccccccccccccC";

function file(overrides: Partial<TokenFile> & Pick<TokenFile, "address" | "symbol">): TokenFile {
  return { name: null, decimals: 18, balance: null, createdByYou: false, ...overrides };
}

describe("mergeTokens", () => {
  it("lists created tokens first, newest first, then holdings by symbol", () => {
    const files = mergeTokens(
      [
        { address: B, name: "Zed", symbol: "ZED", decimals: 18, value: 5n },
        { address: "0xcccccccccccccccccccccccccccccccccccccccc", name: "Alpha", symbol: "ALP", decimals: 6, value: 1n },
      ],
      [
        { address: "0xdddddddddddddddddddddddddddddddddddddddd", symbol: "OLD", decimals: 18 },
        { address: A, symbol: "NEW", decimals: 18 },
      ],
    );
    expect(files.map((f) => f.symbol)).toEqual(["NEW", "OLD", "ALP", "ZED"]);
  });

  it("merges a created token with its holding, case-insensitively", () => {
    const files = mergeTokens(
      [{ address: A.toLowerCase(), name: "Mine", symbol: "MINE", decimals: 18, value: 9n }],
      [{ address: A, symbol: "MINE", decimals: 18 }],
    );
    expect(files).toEqual([{ address: A, symbol: "MINE", name: "Mine", decimals: 18, balance: 9n, createdByYou: true }]);
  });

  // A created token's decimals come from a live on-chain read that can still be pending or can
  // fail; mergeTokens must pass that "unknown" straight through as null rather than inventing a
  // value, so the window never displays a balance under the wrong scale (see Window.tsx, which
  // shows a balance only once decimals is known — Drop already refuses to assume 18 for the same
  // reason).
  it("keeps a created token's decimals null when the on-chain read hasn't resolved", () => {
    const files = mergeTokens([], [{ address: A, symbol: "NEW", decimals: null }]);
    expect(files).toEqual([{ address: A, symbol: "NEW", name: null, decimals: null, balance: null, createdByYou: true }]);
  });
});

describe("duplicateSymbols", () => {
  it("returns an empty set when no symbol repeats", () => {
    const files = [file({ address: A, symbol: "USDC" }), file({ address: B, symbol: "ZED" })];
    expect(duplicateSymbols(files)).toEqual(new Set());
  });

  it("flags symbols shared by two different-address tokens, case-insensitively", () => {
    const files = [file({ address: A, symbol: "USDC" }), file({ address: B, symbol: "usdc" }), file({ address: C, symbol: "ZED" })];
    expect(duplicateSymbols(files)).toEqual(new Set(["usdc"]));
  });

  it("compares symbols after trimming whitespace", () => {
    const files = [file({ address: A, symbol: " USDC " }), file({ address: B, symbol: "USDC" })];
    expect(duplicateSymbols(files)).toEqual(new Set(["usdc"]));
  });

  // Regression guard: a zero-width space isn't Unicode whitespace, so String#trim() (what
  // duplicateSymbols itself uses) leaves it in place — duplicateSymbols alone would NOT catch this
  // pair. It passes only because blockscoutSource now runs every name/symbol through cleanLabel
  // before it ever reaches Finder (see explorer.test.ts), so the zero-width space is already gone
  // by the time a TokenFile's symbol gets here — the explorer layer is what makes this pass, not
  // duplicateSymbols's own comparison.
  it("flags a symbol that only looked different because of a zero-width space, once cleaned at the source", () => {
    const zeroWidthSpace = String.fromCharCode(0x200b);
    const dirty = cleanLabel(`USDC${zeroWidthSpace}`, 32);
    expect(dirty).toBe("USDC"); // the source already stripped it
    const files = [file({ address: A, symbol: dirty! }), file({ address: B, symbol: "USDC" })];
    expect(duplicateSymbols(files)).toEqual(new Set(["usdc"]));
  });
});

describe("officialSymbol", () => {
  it("returns USDC for the real USDC address, case-insensitively", () => {
    expect(officialSymbol(USDC.toUpperCase(), "testnet")).toBe("USDC");
  });

  it("returns EURC for the real EURC address on the active network", () => {
    expect(officialSymbol(EURC.testnet, "testnet")).toBe("EURC");
  });

  it("returns null for the other network's EURC address", () => {
    expect(officialSymbol(EURC.mainnet, "testnet")).toBeNull();
  });

  it("returns null for an unrelated address, even one that claims to be USDC", () => {
    expect(officialSymbol("0x1111111111111111111111111111111111111111", "testnet")).toBeNull();
  });
});

describe("latestSliceStart", () => {
  it("returns 0 when there are no tokens", () => {
    expect(latestSliceStart(0n, 100)).toBe(0n);
  });

  it("returns 0 when the count exactly fills one page", () => {
    expect(latestSliceStart(100n, 100)).toBe(0n);
  });

  it("returns 1 for one token past a full page", () => {
    expect(latestSliceStart(101n, 100)).toBe(1n);
  });

  it("returns count - size for a count well past a full page", () => {
    expect(latestSliceStart(250n, 100)).toBe(150n);
  });
});
