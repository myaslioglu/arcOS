import { afterEach, describe, expect, it, vi } from "vitest";
import { bridgeChainOptions, chainLabel } from "../chains";

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

describe("chainLabel", () => {
  it("labels a picker chain the same as bridgeChainOptions does", () => {
    expect(chainLabel("Ethereum_Sepolia")).toBe("Ethereum Sepolia");
    expect(chainLabel("Ethereum")).toBe("Ethereum");
    expect(chainLabel("Avalanche_Fuji")).toBe("Avalanche Fuji");
  });

  it("also labels Arc itself, which the picker deliberately excludes but which is still a valid source or dest once a bridge is under way", () => {
    expect(chainLabel("Arc")).toBe("Arc");
    expect(chainLabel("Arc_Testnet")).toBe("Arc Testnet");
  });
});
