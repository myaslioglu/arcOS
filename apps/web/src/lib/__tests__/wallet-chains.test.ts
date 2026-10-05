import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAINS } from "@arcos/chain";
import { bridgeChainOptions } from "@/apps/bridge/chains";
import { reportOnlyPolicy } from "../security-headers";
import { destinationChains, walletChains } from "../wallet-chains";

const connectSrc = () =>
  reportOnlyPolicy()
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith("connect-src"))!
    .split(/\s+/)
    .slice(1);

describe("destinationChains", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(["mainnet", "testnet"] as const)("are exactly the chains Bridge offers on %s, under App Kit's ids", (network) => {
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", network);
    expect(destinationChains(network).map((c) => c.kit.chain)).toEqual(bridgeChainOptions().map((o) => o.chain));
  });

  it("pairs each App Kit definition with viem's definition of the same chain", () => {
    for (const network of ["mainnet", "testnet"] as const) {
      for (const { kit, viem } of destinationChains(network)) expect(viem.id, kit.chain).toBe(kit.chainId);
    }
  });
});

describe("walletChains", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("puts the network's Arc first, the other Arc second, then the six destination chains", () => {
    const mainnet = walletChains("mainnet");
    expect(mainnet[0]).toBe(CHAINS.mainnet);
    expect(mainnet[1]).toBe(CHAINS.testnet);
    expect(mainnet.slice(2).map((c) => c.id)).toEqual([1, 8453, 42161, 10, 137, 43114]);
    const testnet = walletChains("testnet");
    expect(testnet[0]).toBe(CHAINS.testnet);
    expect(testnet[1]).toBe(CHAINS.mainnet);
    expect(testnet.slice(2).map((c) => c.id)).toEqual([11155111, 84532, 421614, 11155420, 80002, 43113]);
  });

  it("follows the active network by default", () => {
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
    expect(walletChains()[0]).toBe(CHAINS.mainnet);
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "testnet");
    expect(walletChains()[0]).toBe(CHAINS.testnet);
  });

  // The hosts wagmi's http() transport and WalletConnect's rpcMap take for each chain: App Kit's, which the connect-src
  // already lists, not viem's defaults, which it doesn't.
  it("reads every destination chain through App Kit's RPC endpoints, each of which the connect-src allows", () => {
    const connect = connectSrc();
    for (const network of ["mainnet", "testnet"] as const) {
      const byId = new Map(destinationChains(network).map((c) => [c.viem.id, c.kit]));
      for (const chain of walletChains(network).slice(2)) {
        const kit = byId.get(chain.id)!;
        expect(chain.rpcUrls.default.http, chain.name).toEqual([...kit.rpcEndpoints]);
        for (const url of chain.rpcUrls.default.http) expect(connect, `${chain.name}: ${url}`).toContain(new URL(url).origin);
      }
    }
  });
});
