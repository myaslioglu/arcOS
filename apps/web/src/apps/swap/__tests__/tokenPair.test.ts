import { describe, expect, it } from "vitest";
import { pickToken } from "../tokenPair";

describe("pickToken", () => {
  it("sets the picked token on the given side, unchanged on the other, when they differ", () => {
    expect(pickToken({ tokenIn: "USDC", tokenOut: "EURC" }, "in", "cirBTC")).toEqual({ tokenIn: "cirBTC", tokenOut: "EURC" });
    expect(pickToken({ tokenIn: "USDC", tokenOut: "EURC" }, "out", "cirBTC")).toEqual({ tokenIn: "USDC", tokenOut: "cirBTC" });
  });

  it("swaps the two sides instead of colliding when the picked token matches the other side", () => {
    expect(pickToken({ tokenIn: "USDC", tokenOut: "EURC" }, "in", "EURC")).toEqual({ tokenIn: "EURC", tokenOut: "USDC" });
    expect(pickToken({ tokenIn: "USDC", tokenOut: "EURC" }, "out", "USDC")).toEqual({ tokenIn: "EURC", tokenOut: "USDC" });
  });

  it("picking the same side's current token again is a no-op", () => {
    expect(pickToken({ tokenIn: "USDC", tokenOut: "EURC" }, "in", "USDC")).toEqual({ tokenIn: "USDC", tokenOut: "EURC" });
  });
});

describe("flipTokens", () => {
  it("swaps tokenIn and tokenOut", async () => {
    const { flipTokens } = await import("../tokenPair");
    expect(flipTokens({ tokenIn: "USDC", tokenOut: "EURC" })).toEqual({ tokenIn: "EURC", tokenOut: "USDC" });
  });
});
