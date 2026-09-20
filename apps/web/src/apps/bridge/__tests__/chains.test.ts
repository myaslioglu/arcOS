import { afterEach, describe, expect, it, vi } from "vitest";
import { bridgeChainOptions } from "../chains";

afterEach(() => vi.unstubAllEnvs());

describe("bridgeChainOptions", () => {
  it("offers the testnet EVM chains by default (no NEXT_PUBLIC_ARC_NETWORK set)", () => {
    const options = bridgeChainOptions();
    expect(options.map((o) => o.chain)).toContain("Ethereum_Sepolia");
    expect(options.map((o) => o.chain)).toContain("Arbitrum_Sepolia");
    expect(options).toHaveLength(6);
  });

  it("offers the mainnet EVM chains once NEXT_PUBLIC_ARC_NETWORK=mainnet", () => {
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
    const options = bridgeChainOptions();
    expect(options.map((o) => o.chain)).toContain("Ethereum");
    expect(options.map((o) => o.chain)).not.toContain("Ethereum_Sepolia");
    expect(options).toHaveLength(6);
  });

  it("never lists Arc itself or a non-EVM chain (Solana needs a second wallet adapter this app doesn't have)", () => {
    for (const network of ["testnet", "mainnet"]) {
      vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", network);
      const chains = bridgeChainOptions().map((o) => o.chain);
      expect(chains.some((c) => c.startsWith("Arc"))).toBe(false);
      expect(chains.some((c) => c.startsWith("Solana"))).toBe(false);
    }
  });
});
