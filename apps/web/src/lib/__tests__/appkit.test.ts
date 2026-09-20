import { afterEach, describe, expect, it, vi } from "vitest";
import { bridgeFee, feeRecipient } from "../appkit";

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
