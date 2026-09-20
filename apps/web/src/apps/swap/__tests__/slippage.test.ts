import { describe, expect, it } from "vitest";
import { slippageBpsFor, slippagePercentLabel } from "../slippage";

describe("slippageBpsFor", () => {
  it("is 50 bps (0.5%) for a USDC/EURC pair, in either direction", () => {
    expect(slippageBpsFor("USDC", "EURC")).toBe(50);
    expect(slippageBpsFor("EURC", "USDC")).toBe(50);
  });

  it("is 100 bps (1%) whenever cirBTC is on either side", () => {
    expect(slippageBpsFor("USDC", "cirBTC")).toBe(100);
    expect(slippageBpsFor("cirBTC", "USDC")).toBe(100);
    expect(slippageBpsFor("cirBTC", "EURC")).toBe(100);
  });
});

describe("slippagePercentLabel", () => {
  it("trims a trailing .0 instead of always showing two decimal places", () => {
    expect(slippagePercentLabel(50)).toBe("0.5%");
    expect(slippagePercentLabel(100)).toBe("1%");
  });
});
