import { describe, expect, it } from "vitest";
import { EURC, USDC } from "@arcos/chain";
import { duplicateSymbols, isDuplicateSymbol, latestSliceStart, mergeTokens, officialSymbol, symbolKey, type TokenFile } from "../tokens";

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

  // Regression guard: a zero-width space isn't Unicode whitespace, so String#trim() alone would NOT
  // catch this pair. duplicateSymbols must not depend on every caller having already cleaned the
  // symbol (e.g. an on-chain symbol() read that reaches here uncleaned) — it runs cleanLabel itself
  // before comparing, so the guarantee holds regardless of where the raw symbol came from.
  it("flags a symbol that only looks different because of a zero-width space, even when it arrives uncleaned", () => {
    const files = [file({ address: A, symbol: "USD\u200bC" }), file({ address: B, symbol: "USDC" })];
    expect(duplicateSymbols(files)).toEqual(new Set(["usdc"]));
  });

  // Every token whose symbol() read is still pending shows the same placeholder, which isn't a
  // collision between two tokens claiming the same name \u2014 it's the same "not read yet".
  it("never flags the placeholders shown while a symbol read is pending or has failed", () => {
    const files = [file({ address: A, symbol: "\u2026" }), file({ address: B, symbol: "\u2026" }), file({ address: C, symbol: "?" }), file({ address: "0xdddddddddddddddddddddddddddddddddddddddd", symbol: "?" })];
    expect(duplicateSymbols(files)).toEqual(new Set());
  });

  it("still flags real symbols in a list that also holds placeholders", () => {
    const files = [file({ address: A, symbol: "\u2026" }), file({ address: B, symbol: "USDC" }), file({ address: C, symbol: "USDC" })];
    expect(duplicateSymbols(files)).toEqual(new Set(["usdc"]));
  });
});

// The Finder asks this, once, about each token it draws. It exists as a function so the lookup is
// covered by a test: the window used to key its query itself, and a query keyed differently from
// the set silently answers "no duplicates" forever.
describe("isDuplicateSymbol", () => {
  it("answers yes for a raw, uncleaned symbol that collides with another token's", () => {
    const dirty = " USD\u200bC ";
    const dupes = duplicateSymbols([file({ address: A, symbol: dirty }), file({ address: B, symbol: "USDC" })]);
    expect(isDuplicateSymbol(dupes, dirty)).toBe(true);
    expect(isDuplicateSymbol(dupes, "usdc")).toBe(true);
  });

  it("answers no for a symbol nothing else claims, and for the pending-read placeholders", () => {
    const dupes = duplicateSymbols([file({ address: A, symbol: "USDC" }), file({ address: B, symbol: "USDC" }), file({ address: C, symbol: "?" })]);
    expect(isDuplicateSymbol(dupes, "ZED")).toBe(false);
    expect(isDuplicateSymbol(dupes, "?")).toBe(false);
  });
});

describe("symbolKey", () => {
  // The Finder's only call site asks `dupes.has(...)` with a token's raw symbol, so the key the
  // caller builds has to be the key duplicateSymbols stored \u2014 one exported normaliser, used by
  // both, or the whole defence is bypassed at the point it's meant to fire.
  it("keys a raw, uncleaned symbol exactly the way duplicateSymbols keyed it", () => {
    const dirty = " USD\u200bC ";
    const files = [file({ address: A, symbol: dirty }), file({ address: B, symbol: "USDC" })];
    expect(duplicateSymbols(files).has(symbolKey(dirty))).toBe(true);
    expect(symbolKey(dirty)).toBe("usdc");
  });

  it("gives a placeholder a key that is never in the duplicate set", () => {
    expect(duplicateSymbols([file({ address: A, symbol: "?" }), file({ address: B, symbol: "?" })]).has(symbolKey("?"))).toBe(false);
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
