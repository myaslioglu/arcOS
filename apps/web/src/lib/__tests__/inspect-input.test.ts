import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import { activeChain } from "@arcos/chain";
import { inspectInput, proExplorerApi } from "../inspect-input";

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

  it("keeps linking evidence to the public explorer either way", () => {
    expect(inspectInput(T, client, fetch, PRO).explorerBase).toBe(chainExplorer.url);
    expect(inspectInput(T, client).explorerBase).toBe(chainExplorer.url);
  });
});
