import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { anyChainName, chainName, inspectorParams, pickToken, readsOtherChains, siteChain, siteChainBySlug, siteInspectChains } from "../inspect-chain-pick";

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

beforeEach(() => vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet"));
afterEach(() => vi.unstubAllEnvs());

describe("the chains the site's Inspector reads", () => {
  it("is Arc alone while the flag is unset, and on the testnet site whatever it says", () => {
    expect(siteInspectChains().map((c) => c.key)).toEqual(["arc"]);
    expect(readsOtherChains()).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "testnet");
    vi.stubEnv("NEXT_PUBLIC_INSPECT_CHAINS", "ethereum,base,arbitrum,optimism");
    expect(siteInspectChains().map((c) => c.key)).toEqual(["arc"]);
    expect(readsOtherChains()).toBe(false);
  });

  it("is Arc first, then each chain the flag switches on, in the registry's order", () => {
    vi.stubEnv("NEXT_PUBLIC_INSPECT_CHAINS", "optimism, base");
    expect(siteInspectChains().map((c) => c.key)).toEqual(["arc", "base", "optimism"]);
    expect(readsOtherChains()).toBe(true);
    expect(siteChain("base")?.chainId).toBe(8453);
    expect(siteChain("ethereum")).toBeNull();
    expect(siteChainBySlug(" BASE ")?.key).toBe("base");
    expect(siteChainBySlug("arc")?.key).toBe("arc");
    expect(siteChainBySlug("polygon")).toBeNull();
  });
});

describe("names and params", () => {
  it("calls Arc Arc on both networks, and every other chain by its registry name", () => {
    vi.stubEnv("NEXT_PUBLIC_INSPECT_CHAINS", "optimism");
    expect(siteInspectChains().map(chainName)).toEqual(["Arc", "OP Mainnet"]);
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "testnet");
    expect(chainName(siteInspectChains()[0]!)).toBe("Arc");
    expect(anyChainName("arbitrum")).toBe("Arbitrum One");
  });

  it("opens Arc's Inspector on the token alone, as it always has, and another chain's with its slug", () => {
    vi.stubEnv("NEXT_PUBLIC_INSPECT_CHAINS", "base");
    expect(inspectorParams(siteChain("arc")!, BASE_USDC)).toEqual({ token: BASE_USDC });
    expect(inspectorParams(siteChain("base")!, BASE_USDC)).toEqual({ chain: "base", token: BASE_USDC });
  });
});

describe("pickToken", () => {
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_INSPECT_CHAINS", "base"));

  it("reads a bare address as naming no chain", () => {
    expect(pickToken(BASE_USDC.toLowerCase())).toEqual({ kind: "token", address: BASE_USDC, chain: null });
  });

  it("reads a link or a prefix on a chain the site reads as that chain", () => {
    const picked = pickToken(`https://basescan.org/token/${BASE_USDC}`);
    expect(picked.kind === "token" && picked.chain?.key).toBe("base");
    expect(pickToken(`base:${BASE_USDC}`)).toMatchObject({ kind: "token", address: BASE_USDC });
    expect(pickToken(`https://explorer.arc.io/token/${BASE_USDC}`)).toMatchObject({ kind: "token", chain: { key: "arc" } });
  });

  it("says which chain a link names when the site doesn't read it, and nothing for text that names no token", () => {
    expect(pickToken(`https://etherscan.io/token/${BASE_USDC}`)).toEqual({ kind: "elsewhere", chain: "ethereum" });
    expect(pickToken(`arb1:${BASE_USDC}`)).toEqual({ kind: "elsewhere", chain: "arbitrum" });
    for (const text of ["", "mint", "0x123", `polygon:${BASE_USDC}`, `https://dexscreener.com/base/${BASE_USDC}`]) {
      expect(pickToken(text), text).toEqual({ kind: "none" });
    }
  });
});
