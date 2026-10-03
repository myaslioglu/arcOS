import { BridgeChain } from "@circle-fin/app-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bridgeChainInfo, bridgeChainOptions, chainLabel, unsupportedBridgeChains } from "../chains";

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

describe("unsupportedBridgeChains", () => {
  it("shows BNB Smart Chain on mainnet and its testnet on testnet, each saying Circle has no USDC there", () => {
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
    expect(unsupportedBridgeChains()).toEqual([{ label: "BNB Smart Chain", note: "Circle has no USDC there" }]);
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "testnet");
    expect(unsupportedBridgeChains()).toEqual([{ label: "BNB Smart Chain Testnet", note: "Circle has no USDC there" }]);
  });

  it("never names a chain Bridge offers", () => {
    for (const network of ["testnet", "mainnet"]) {
      vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", network);
      const offered = bridgeChainOptions().map((o) => o.label);
      for (const u of unsupportedBridgeChains()) expect(offered, network).not.toContain(u.label);
    }
  });

  it("matches the installed App Kit: once its BridgeChain enum names BNB Smart Chain, it's time to re-check", () => {
    // Whole name parts only ("BNB_Smart_Chain", "BSC", "Binance_..."), so "Obscuro" or "opBNB" can't trip it.
    const bnb = Object.values(BridgeChain).filter((c) => c.split("_").some((part) => /^(bnb|bsc|binance)$/i.test(part)));
    expect(
      bnb,
      "App Kit's BridgeChain now names BNB Smart Chain: if Circle's docs list USDC (not only USYC) there, move it from UNSUPPORTED_* to MAINNET/TESTNET in chains.ts",
    ).toEqual([]);
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

describe("bridgeChainInfo", () => {
  it("knows every chain Bridge offers, on both networks, and Arc itself, from App Kit's own definitions", () => {
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
    const mainnet = bridgeChainOptions().map((o) => o.chain);
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "testnet");
    const testnet = bridgeChainOptions().map((o) => o.chain);
    for (const chain of [...mainnet, ...testnet, "Arc", "Arc_Testnet"] as const) {
      const info = bridgeChainInfo(chain);
      expect(info, chain).not.toBeNull();
      expect(info!.rpcEndpoints.length, chain).toBeGreaterThan(0);
      expect(info!.usdcAddress, chain).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it("names each chain's gas token: USDC on Arc, ETH on the rollups, POL and AVAX on theirs", () => {
    expect(bridgeChainInfo("Arc")).toMatchObject({ chainId: 5042, gasSymbol: "USDC", usdcAddress: "0x3600000000000000000000000000000000000000" });
    expect(bridgeChainInfo("Ethereum")?.gasSymbol).toBe("ETH");
    expect(bridgeChainInfo("Base")).toMatchObject({ chainId: 8453, gasSymbol: "ETH", usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" });
    expect(bridgeChainInfo("Polygon")?.gasSymbol).toBe("POL");
    expect(bridgeChainInfo("Avalanche")?.gasSymbol).toBe("AVAX");
  });

  it("returns null for a chain it doesn't define", () => {
    expect(bridgeChainInfo("Solana" as never)).toBeNull();
  });
});
