import { describe, expect, it } from "vitest";
import { EURC, USDC } from "@arcos/chain";
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
