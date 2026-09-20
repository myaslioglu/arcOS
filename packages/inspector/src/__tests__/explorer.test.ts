import { describe, expect, it } from "vitest";
import { ExplorerUnavailable, blockscoutSource } from "../explorer";

const API = "https://explorer.test/api/v2";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fakeFetch(routes: Record<string, Response | Error>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const hit = routes[String(input).replace(API, "")];
    if (!hit) return json({ message: "Not found" }, 404);
    if (hit instanceof Error) throw hit;
    return hit;
  }) as typeof fetch;
}

const T = "0x1111111111111111111111111111111111111111";

describe("blockscoutSource", () => {
  it("maps a verified contract", async () => {
    const src = blockscoutSource(API, fakeFetch({
      [`/smart-contracts/${T}`]: json({
        is_verified: true, name: "Duke", abi: [{ type: "function", name: "mint" }],
        proxy_type: null, implementations: [{ address_hash: "0x2222222222222222222222222222222222222222" }],
      }),
    }));
    expect(await src.contract(T)).toEqual({
      verified: true, name: "Duke", abi: [{ type: "function", name: "mint" }],
      proxyType: null, implementations: ["0x2222222222222222222222222222222222222222"],
    });
  });

  it("treats 404 as 'not verified', not as an outage", async () => {
    const src = blockscoutSource(API, fakeFetch({}));
    expect(await src.contract(T)).toEqual({ verified: false, name: null, abi: null, proxyType: null, implementations: [] });
    expect(await src.token(T)).toBeNull();
    expect(await src.topHolders(T)).toEqual([]);
  });

  it("throws ExplorerUnavailable on a bot challenge, a 5xx or a network error", async () => {
    const challenge = new Response("<html>Just a moment…</html>", { status: 403 });
    await expect(blockscoutSource(API, fakeFetch({ [`/tokens/${T}`]: challenge })).token(T)).rejects.toMatchObject({
      name: "ExplorerUnavailable", status: 403,
    });
    await expect(blockscoutSource(API, fakeFetch({ [`/tokens/${T}`]: json({}, 503) })).token(T)).rejects.toBeInstanceOf(ExplorerUnavailable);
    await expect(blockscoutSource(API, fakeFetch({ [`/tokens/${T}`]: new Error("ECONNRESET") })).token(T)).rejects.toMatchObject({ status: null });
  });

  it("parses holders and token balances into bigints", async () => {
    const src = blockscoutSource(API, fakeFetch({
      [`/tokens/${T}/holders`]: json({ items: [
        { address: { hash: "0xAAA", is_contract: true, name: "Pool" }, value: "900" },
        { address: { hash: "0xBBB", is_contract: false, name: null }, value: "100" },
      ] }),
      [`/addresses/${T}/token-balances`]: json([
        { token: { address_hash: "0xCCC", name: "Duke", symbol: "DUKE", decimals: "18", type: "ERC-20" }, value: "5" },
        { token: { address_hash: "0xDDD", name: "Art", symbol: "ART", decimals: null, type: "ERC-721" }, value: "1" },
      ]),
    }));
    expect(await src.topHolders(T)).toEqual([
      { address: "0xAAA", isContract: true, name: "Pool", value: 900n },
      { address: "0xBBB", isContract: false, name: null, value: 100n },
    ]);
    expect(await src.tokenBalances(T)).toEqual([{ address: "0xCCC", name: "Duke", symbol: "DUKE", decimals: 18, value: 5n }]);
  });
});
