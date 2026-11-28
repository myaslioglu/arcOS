import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { anyChainName, chainName, chainNamed, inspectorParams, notReadHere, pickToken, readsOtherChains, siteChain, siteChainBySlug, siteInspectChains } from "../inspect-chain-pick";
import { parseInspectTarget } from "../inspect-target";

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
    expect(notReadHere("OP Mainnet")).toBe("Inspector doesn't read OP Mainnet on this site.");
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
    expect(pickToken(`https://etherscan.io/token/${BASE_USDC}`)).toEqual({ kind: "elsewhere", name: "Ethereum" });
    expect(pickToken(`arb1:${BASE_USDC}`)).toEqual({ kind: "elsewhere", name: "Arbitrum One" });
    for (const text of ["", "mint", "0x123", `polygon:${BASE_USDC}`, `https://dexscreener.com/base/${BASE_USDC}`]) {
      expect(pickToken(text), text).toEqual({ kind: "none" });
    }
  });

  it("takes only the registry's chains, never a name an object has of its own", () => {
    for (const text of [
      `constructor:${BASE_USDC}`,
      `https://constructor/token/${BASE_USDC}`,
      `https://app.uniswap.org/explore/tokens/constructor/${BASE_USDC}`,
    ]) {
      expect(pickToken(text), text).toEqual({ kind: "none" });
    }
  });
});

describe("pickToken and Arc's other network", () => {
  const mainnetLinks = [
    `https://4rcos.com/t/${BASE_USDC}`,
    `https://www.4rcos.com/badge/${BASE_USDC}`,
    `4rcos.com/t/arc/${BASE_USDC}`,
    `https://explorer.arc.io/token/${BASE_USDC}`,
    `eip155:5042:${BASE_USDC}`,
  ];
  const testnetLinks = [
    `https://testnet.4rcos.com/t/${BASE_USDC}`,
    `https://testnet.4rcos.com/badge/${BASE_USDC}`,
    `testnet.4rcos.com/t/arc/${BASE_USDC}`,
    `https://explorer.testnet.arc.io/address/${BASE_USDC}#code`,
    `EIP155:5042002:${BASE_USDC}`,
  ];

  it("on the mainnet site, reads mainnet's links as Arc and refuses the testnet's by name", () => {
    vi.stubEnv("NEXT_PUBLIC_INSPECT_CHAINS", "base");
    for (const text of mainnetLinks) expect(pickToken(text), text).toMatchObject({ kind: "token", address: BASE_USDC, chain: { key: "arc", chainId: 5042 } });
    for (const text of testnetLinks) expect(pickToken(text), text).toEqual({ kind: "elsewhere", name: "Arc Testnet" });
    // `arc:` names no network: it is this site's Arc.
    expect(pickToken(`arc:${BASE_USDC}`)).toMatchObject({ kind: "token", chain: { chainId: 5042 } });
  });

  it("on the testnet site, reads the testnet's links as Arc and refuses mainnet's by name", () => {
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "testnet");
    vi.stubEnv("NEXT_PUBLIC_INSPECT_CHAINS", "base");
    for (const text of testnetLinks) expect(pickToken(text), text).toMatchObject({ kind: "token", address: BASE_USDC, chain: { key: "arc", chainId: 5042002 } });
    for (const text of mainnetLinks) expect(pickToken(text), text).toEqual({ kind: "elsewhere", name: "Arc mainnet" });
    expect(pickToken(`arc:${BASE_USDC}`)).toMatchObject({ kind: "token", chain: { chainId: 5042002 } });
    expect(pickToken(`https://4rcos.com/t/base/${BASE_USDC}`)).toEqual({ kind: "elsewhere", name: "Base" });
  });
});

describe("chainNamed", () => {
  it("reads the names the prefix form reads, in any case, whether or not the site reads the chain", () => {
    expect(["arc", "ethereum", "ETH", "base", "Arbitrum", "arb1", "optimism", "oeth"].map(chainNamed)).toEqual([
      "arc",
      "ethereum",
      "ethereum",
      "base",
      "arbitrum",
      "arbitrum",
      "optimism",
      "optimism",
    ]);
  });

  it("names the chain `<name>:0x…` names, for every name tried", () => {
    for (const name of ["arc", "ARC", "ethereum", "eth", "Base", "arbitrum", "arb1", "optimism", "OETH", "op", "polygon", "matic", "eip155"]) {
      expect(chainNamed(name), name).toBe(parseInspectTarget(`${name}:${BASE_USDC}`)?.chain ?? null);
    }
  });

  it("is null for any other name, and for anything that isn't a name", () => {
    for (const name of ["", "polygon", "op", "eip155", "constructor", "__proto__", `base:${BASE_USDC}`, "basescan.org/token", `https://basescan.org/token/${BASE_USDC}?x=`]) {
      expect(chainNamed(name), name).toBeNull();
    }
  });
});
