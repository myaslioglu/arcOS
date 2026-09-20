import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAINS, activeNetwork, explorerUrl } from "../chains";

afterEach(() => vi.unstubAllEnvs());

describe("chains", () => {
  it("has the documented chain ids", () => {
    expect(CHAINS.mainnet.id).toBe(5042);
    expect(CHAINS.testnet.id).toBe(5042002);
  });

  it("defaults to testnet and only switches on an explicit mainnet flag", () => {
    expect(activeNetwork()).toBe("testnet");
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
    expect(activeNetwork()).toBe("mainnet");
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "Mainnet ");
    expect(activeNetwork()).toBe("testnet");
  });

  it("builds explorer links", () => {
    expect(explorerUrl("address", "0xabc", "mainnet")).toBe("https://explorer.arc.io/address/0xabc");
    expect(explorerUrl("tx", "0xdef", "mainnet")).toBe("https://explorer.arc.io/tx/0xdef");
    expect(explorerUrl("token", "0xabc", "mainnet")).toBe("https://explorer.arc.io/token/0xabc");
    expect(explorerUrl("address", "0xabc", "testnet")).toBe("https://explorer.testnet.arc.io/address/0xabc");
  });

  it("points testnet at the documented hosts, not viem's stale ones", () => {
    expect(CHAINS.testnet.rpcUrls.default.http[0]).toBe("https://rpc.testnet.arc.io");
    expect(CHAINS.testnet.blockExplorers?.default.apiUrl).toBe("https://explorer.testnet.arc.io/api/v2");
    expect(CHAINS.mainnet.blockExplorers?.default.apiUrl).toBe("https://explorer.arc.io/api/v2");
  });
});
