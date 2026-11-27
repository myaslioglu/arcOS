import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import { DEX, INSPECT_CHAINS, USDC, activeChain, arcInspectChain, inspectChain } from "@arcos/chain";
import { inspectInput, inspectInputFor } from "../inspect-input";

const T = "0x1111111111111111111111111111111111111111";
const PRO = { url: "https://api.blockscout.com/5042/api/v2", apiKey: "proapi_k" };

function recording() {
  const calls: { url: string; headers: Headers }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify({ is_verified: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe("inspectInput", () => {
  afterEach(() => vi.unstubAllEnvs());
  const client = {} as PublicClient;
  const chainExplorer = activeChain().blockExplorers!.default;

  it("reads the chain's public explorer, with no key, when not given an explorer API (the browser's path)", async () => {
    const { calls, fetchFn } = recording();
    await inspectInput(T, client, fetchFn).explorer!.contract(T);
    expect(calls[0].url).toBe(`${chainExplorer.apiUrl}/smart-contracts/${T}`);
    expect(calls[0].headers.has("authorization")).toBe(false);
  });

  it("reads the given explorer API with its key (the server's path)", async () => {
    const { calls, fetchFn } = recording();
    await inspectInput(T, client, fetchFn, PRO).explorer!.contract(T);
    expect(calls[0].url).toBe(`${PRO.url}/smart-contracts/${T}`);
    expect(calls[0].headers.get("authorization")).toBe("Bearer proapi_k");
  });

  it("names each network's own ArcOS TokenFactory, so its tokens can be recognized", () => {
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
    expect(inspectInput(T, client).arcosTokenFactory).toBe("0xa68edD822048C00dC816d93005B72F8a50234a24");
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "testnet");
    expect(inspectInput(T, client).arcosTokenFactory).toBe("0x41FaFc54ED3be1545695B82af4aA490607447884");
  });

  // The browser Inspector and the server both build their input here, so this is where each network's pools get named.
  it("reads Uniswap v4 on both networks and Aerodrome on mainnet only, and fills no extra pools yet", () => {
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
    expect(inspectInput(T, client).dex).toBe(DEX.mainnet);
    expect(inspectInput(T, client).dex?.v4).toBeDefined();
    expect(inspectInput(T, client).dex?.aero).toBeDefined();
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "testnet");
    expect(inspectInput(T, client).dex).toBe(DEX.testnet);
    expect(inspectInput(T, client).dex?.v4).toBeDefined();
    expect(inspectInput(T, client).dex?.aero).toBeUndefined();
    expect(inspectInput(T, client).extraPools).toBeUndefined();
  });

  it("describes Arc on the site's network from its registry entry: the chain, its quotes and its PREVRANDAO wording", () => {
    for (const [network, chainId] of [["mainnet", 5042], ["testnet", 5042002]] as const) {
      vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", network);
      expect(inspectInput(T, client), network).toMatchObject({
        network,
        chain: { key: "arc", chainId },
        nativeQuote: { address: "0x0000000000000000000000000000000000000000", symbol: "USDC", decimals: 18 },
        tradeQuote: { token: USDC, balanceSlot: null },
        lockersVetted: true,
        unscanned: [],
        prevrandao: arcInspectChain(network).prevrandao,
      });
    }
  });

  it("keeps linking evidence to the public explorer either way", () => {
    expect(inspectInput(T, client, fetch, PRO).explorerBase).toBe(chainExplorer.url);
    expect(inspectInput(T, client).explorerBase).toBe(chainExplorer.url);
  });

  describe("inspectInputFor, off Arc", () => {
    const base = inspectChain("mainnet", "base")!;
    const BASE_PRO = { url: "https://api.blockscout.com/8453/api/v2", apiKey: "proapi_k" };

    it("describes each chain from its own registry entry, with the site's network on the report", () => {
      vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
      for (const chain of INSPECT_CHAINS.mainnet.filter((c) => c.key !== "arc")) {
        const input = inspectInputFor(chain, T, client);
        expect(input, chain.key).toMatchObject({
          network: "mainnet",
          chain: { key: chain.key, name: chain.name, chainId: chain.chainId },
          dex: chain.dex,
          explorerBase: chain.explorer.url,
          tradeQuote: chain.tradeQuote,
          nativeQuote: chain.nativeQuote,
          lockersVetted: false,
          unverifiedFails: false,
          unscanned: chain.unscanned,
          prevrandao: chain.prevrandao,
          arcosTokenFactory: null,
        });
      }
    });

    it("reads no explorer without an explorer API: no chain but Arc has one a server may read for free", () => {
      expect(inspectInputFor(base, T, client).explorer).toBeNull();
    });

    it("reads the chain's PRO API with its key, and links evidence to the chain's Blockscout", async () => {
      const { calls, fetchFn } = recording();
      const input = inspectInputFor(base, T, client, { fetchFn, explorerApi: BASE_PRO });
      await input.explorer!.contract(T);
      expect(calls[0].url).toBe(`${BASE_PRO.url}/smart-contracts/${T}`);
      expect(calls[0].headers.get("authorization")).toBe("Bearer proapi_k");
      expect(input.explorerBase).toBe("https://base.blockscout.com");
    });

    it("leaves the explorer out, with the reason, when told to skip it", () => {
      const input = inspectInputFor(base, T, client, { explorerApi: BASE_PRO, explorerSkipped: "The explorer wasn't asked." });
      expect(input.explorer).toBeNull();
      expect(input.explorerSkipped).toBe("The explorer wasn't asked.");
    });

    it("carries a second verification source when given one, and none otherwise", () => {
      const verifyFallback = { verified: async () => true };
      expect(inspectInputFor(base, T, client, { verifyFallback }).verifyFallback).toBe(verifyFallback);
      expect("verifyFallback" in inspectInputFor(base, T, client)).toBe(false);
    });

    it("gives Arc's wrapper exactly what Arc's entry gives", () => {
      vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
      const viaWrapper = inspectInput(T, client);
      const direct = inspectInputFor(arcInspectChain("mainnet"), T, client);
      expect(Object.keys(viaWrapper)).toEqual(Object.keys(direct));
      expect({ ...viaWrapper, reader: null, explorer: null }).toEqual({ ...direct, reader: null, explorer: null });
    });
  });
});
