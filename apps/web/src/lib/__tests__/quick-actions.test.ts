import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { quickActions } from "../quick-actions";

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

afterEach(() => vi.unstubAllEnvs());

describe("quickActions", () => {
  it("offers an inspection for a pasted address", () => {
    const a = "0x3600000000000000000000000000000000000000";
    expect(quickActions(` ${a} `)).toEqual([
      { id: `inspect:${a}`, title: "Inspect 0x3600…0000", hint: "Token report", appId: "inspector", params: { token: a } },
    ]);
  });
  it("offers nothing otherwise", () => {
    expect(quickActions("mint")).toEqual([]);
    expect(quickActions("0x123")).toEqual([]);
  });
});

describe("quickActions while the site reads Arc alone", () => {
  it("gives the one action it always has, on mainnet with the flag unset too", () => {
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
    expect(quickActions(BASE_USDC)).toEqual([
      { id: `inspect:${BASE_USDC}`, title: "Inspect 0x8335…2913", hint: "Token report", appId: "inspector", params: { token: BASE_USDC } },
    ]);
    expect(quickActions(`https://basescan.org/token/${BASE_USDC}`)).toEqual([]);
  });
});

describe("quickActions once the site reads other chains", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
    vi.stubEnv("NEXT_PUBLIC_INSPECT_CHAINS", "base,ethereum");
  });

  it("offers a bare address on every chain the site reads, Arc's first", () => {
    const a = BASE_USDC.toLowerCase();
    expect(quickActions(a)).toEqual([
      { id: `inspect:arc:${a}`, title: "Inspect 0x8335…2913 on Arc", hint: "Token report", appId: "inspector", params: { token: a } },
      { id: `inspect:ethereum:${a}`, title: "Inspect 0x8335…2913 on Ethereum", hint: "Token report", appId: "inspector", params: { chain: "ethereum", token: a } },
      { id: `inspect:base:${a}`, title: "Inspect 0x8335…2913 on Base", hint: "Token report", appId: "inspector", params: { chain: "base", token: a } },
    ]);
  });

  it("offers a pasted link, or a chain prefix, on the chain it names alone", () => {
    const onBase = [
      { id: `inspect:base:${BASE_USDC}`, title: "Inspect 0x8335…2913 on Base", hint: "Token report", appId: "inspector", params: { chain: "base", token: BASE_USDC } },
    ];
    expect(quickActions(`https://basescan.org/token/${BASE_USDC}`)).toEqual(onBase);
    expect(quickActions(`base:${BASE_USDC.toLowerCase()}`)).toEqual(onBase);
    expect(quickActions(`https://4rcos.com/t/${BASE_USDC}`)).toEqual([
      { id: `inspect:arc:${BASE_USDC}`, title: "Inspect 0x8335…2913 on Arc", hint: "Token report", appId: "inspector", params: { token: BASE_USDC } },
    ]);
  });

  it("offers nothing for a chain the site doesn't read, nor for text that names no token", () => {
    expect(quickActions(`https://arbiscan.io/token/${BASE_USDC}`)).toEqual([]);
    expect(quickActions("mint")).toEqual([]);
    expect(quickActions("0x123")).toEqual([]);
  });

  it("offers nothing for a link or chain id of the testnet, never the address on mainnet's Arc", () => {
    expect(quickActions(`https://testnet.4rcos.com/t/${BASE_USDC}`)).toEqual([]);
    expect(quickActions(`https://explorer.testnet.arc.io/token/${BASE_USDC}`)).toEqual([]);
    expect(quickActions(`eip155:5042002:${BASE_USDC}`)).toEqual([]);
  });
});
