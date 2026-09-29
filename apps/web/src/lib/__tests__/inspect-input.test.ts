import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import { DEX, activeChain } from "@arcos/chain";
import { inspectInput, proExplorerApi, proLogsApi } from "../inspect-input";

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

describe("proExplorerApi", () => {
  it("is off without a key", () => {
    expect(proExplorerApi(5042, undefined)).toBeUndefined();
    expect(proExplorerApi(5042, "")).toBeUndefined();
    expect(proExplorerApi(5042, "  \n")).toBeUndefined();
  });

  it("points at the chain's Blockscout PRO API, with the key trimmed", () => {
    expect(proExplorerApi(5042, " proapi_k \n")).toEqual(PRO);
    expect(proExplorerApi(5042002, "proapi_k")?.url).toBe("https://api.blockscout.com/5042002/api/v2");
  });
});

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

  it("names each network's own 4rc.OS TokenFactory, so its tokens can be recognized", () => {
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

  it("keeps linking evidence to the public explorer either way", () => {
    expect(inspectInput(T, client, fetch, PRO).explorerBase).toBe(chainExplorer.url);
    expect(inspectInput(T, client).explorerBase).toBe(chainExplorer.url);
  });
});

describe("proLogsApi", () => {
  it("is off without a key", () => {
    expect(proLogsApi(5042, undefined)).toBeUndefined();
    expect(proLogsApi(5042, "  \n")).toBeUndefined();
  });

  it("points at the logs module of the chain's Blockscout PRO API, with the key trimmed", () => {
    expect(proLogsApi(5042, " proapi_k \n")).toEqual({ url: "https://api.blockscout.com/5042/api", apiKey: "proapi_k" });
  });
});
