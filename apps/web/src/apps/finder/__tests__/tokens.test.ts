import { describe, expect, it } from "vitest";
import { mergeTokens } from "../tokens";

const A = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

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
