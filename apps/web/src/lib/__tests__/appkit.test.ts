import { afterEach, describe, expect, it, vi } from "vitest";
import { SWAP_TOKEN_DECIMALS, bridgeFee, feePercentLabel, feeRecipient } from "../appkit";

afterEach(() => vi.unstubAllEnvs());

describe("bridgeFee", () => {
  it("is 0.20% of the amount, floored to 6 places", () => {
    expect(bridgeFee("100")).toBe("0.2");
    expect(bridgeFee("1,250.50")).toBe("2.501");
    expect(bridgeFee("0.0001")).toBe("0");
    expect(bridgeFee("33.333333")).toBe("0.066666");
  });
  it("is 0 for input that isn't an amount", () => {
    expect(bridgeFee("")).toBe("0");
    expect(bridgeFee("abc")).toBe("0");
  });
});

describe("feeRecipient", () => {
  it("returns a checksummed address or null", () => {
    expect(feeRecipient()).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_FEE_RECIPIENT", "0x000000000000000000000000000000000000dead");
    expect(feeRecipient()).toBe("0x000000000000000000000000000000000000dEaD");
    vi.stubEnv("NEXT_PUBLIC_FEE_RECIPIENT", "nope");
    expect(feeRecipient()).toBeNull();
  });
});

// Not resolvable synchronously from the installed SDK: `getTokenDecimals` (exported by
// @circle-fin/app-kit) is async and needs a live adapter/chain, and `createTokenRegistry`
// (referenced only in that function's own JSDoc example) isn't in the package's public export list
// — see node_modules/@circle-fin/app-kit/index.d.ts's final `export { ... }` statement, which omits
// it. USDC and EURC are both Circle-issued stablecoins at 6 decimals (confirmed for USDC by the
// SDK's own `TokenInfo` example, index.d.ts ~line 1271: `{ name: 'USDC', symbol: 'USDC', decimals: 6
// }`); cirBTC mirrors Bitcoin's 8-decimal convention, the same precision the SDK's own docs use for
// the other BTC-pegged token it names, WBTC (index.d.ts ~line 9946: "await
// getTokenDecimals('WBTC', ...) // 8").
describe("SWAP_TOKEN_DECIMALS", () => {
  it("is 6 for USDC and EURC, 8 for cirBTC", () => {
    expect(SWAP_TOKEN_DECIMALS).toEqual({ USDC: 6, EURC: 6, cirBTC: 8 });
  });
});

describe("feePercentLabel", () => {
  it("formats basis points as a fixed two-decimal percentage", () => {
    expect(feePercentLabel(20)).toBe("0.20%");
    expect(feePercentLabel(100)).toBe("1.00%");
  });
});
