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

  it("treats 404 as 'no record of this contract', neither 'not verified' nor an outage", async () => {
    const src = blockscoutSource(API, fakeFetch({}));
    // `verified: null` is "the explorer has nothing on this address", which is not the same claim
    // as "the explorer has this address and says its source isn't verified".
    expect(await src.contract(T)).toEqual({ verified: null, name: null, abi: null, proxyType: null, implementations: [] });
    expect(await src.token(T)).toBeNull();
    expect(await src.topHolders(T)).toBeNull(); // a 404 holder list is "unknown", never "zero holders"
  });

  it("only reports 'not verified' on an explicit is_verified: false", async () => {
    const no = blockscoutSource(API, fakeFetch({ [`/smart-contracts/${T}`]: json({ is_verified: false, name: "X", abi: null, proxy_type: null, implementations: [] }) }));
    expect((await no.contract(T)).verified).toBe(false);
    // A 200 whose body simply doesn't carry the field says nothing either way.
    const silent = blockscoutSource(API, fakeFetch({ [`/smart-contracts/${T}`]: json({ name: "X" }) }));
    expect((await silent.contract(T)).verified).toBeNull();
  });

  // Measured on the Arc TESTNET explorer, 2026-09-21. Every number in the token record arrives as
  // a STRING, and the holder list is paginated 50 at a time with `next_page_params` describing the
  // next page — or `null` when this page is the last one, which is the explorer positively saying
  // the list is complete.
  describe("the shapes the real explorer actually sends", () => {
    const realToken = {
      address_hash: "0x3600000000000000000000000000000000000000",
      decimals: "6",
      holders_count: "4939808",
      name: "USDC",
      symbol: "USDC",
      total_supply: "315059781045050047",
      type: "ERC-20",
    };
    const holderItem = (hash: string, value: string) => ({
      address: { hash, is_contract: false, is_verified: false, name: null, ens_domain_name: null },
      token_id: null,
      value,
    });

    it("parses a token record whose every number is a string", async () => {
      const src = blockscoutSource(API, fakeFetch({ [`/tokens/${T}`]: json(realToken) }));
      expect(await src.token(T)).toEqual({
        name: "USDC", symbol: "USDC", decimals: 6, totalSupply: "315059781045050047", holdersCount: 4939808,
      });
    });

    it("calls a holder page complete only when the explorer says there is no next page", async () => {
      const lastPage = blockscoutSource(API, fakeFetch({
        [`/tokens/${T}/holders`]: json({ items: [holderItem("0xAAA", "247124236425957170")], next_page_params: null }),
      }));
      expect(await lastPage.topHolders(T)).toEqual({
        holders: [{ address: "0xAAA", isContract: false, name: null, value: 247124236425957170n }],
        complete: true,
      });

      const oneOfMany = blockscoutSource(API, fakeFetch({
        [`/tokens/${T}/holders`]: json({
          items: [holderItem("0xAAA", "1"), holderItem("0xBBB", "2")],
          next_page_params: { value: "247124236425957170", address_hash: "0xAAA", items_count: 50 },
        }),
      }));
      expect((await oneOfMany.topHolders(T))!.complete).toBe(false);
    });

    it("doesn't call a page complete just because the field is missing", async () => {
      const src = blockscoutSource(API, fakeFetch({ [`/tokens/${T}/holders`]: json({ items: [holderItem("0xAAA", "1")] }) }));
      expect((await src.topHolders(T))!.complete).toBe(false);
    });
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
    expect(await src.topHolders(T)).toEqual({
      holders: [
        { address: "0xAAA", isContract: true, name: "Pool", value: 900n },
        { address: "0xBBB", isContract: false, name: null, value: 100n },
      ],
      complete: false,
    });
    expect(await src.tokenBalances(T)).toEqual([{ address: "0xCCC", name: "Duke", symbol: "DUKE", decimals: 18, value: 5n }]);
  });

  it("cleans a zero-width space and a bidi override out of every name and symbol it returns", async () => {
    const ZWSP = String.fromCharCode(0x200b); // zero-width space
    const RLO = String.fromCharCode(0x202e); // right-to-left override
    const src = blockscoutSource(API, fakeFetch({
      [`/smart-contracts/${T}`]: json({
        is_verified: true, name: `Du${ZWSP}ke`, abi: null, proxy_type: null, implementations: [],
      }),
      [`/tokens/${T}`]: json({
        name: `${RLO}EKTA`, symbol: `USD${ZWSP}C`, decimals: "18", total_supply: "1", holders_count: 1,
      }),
      [`/tokens/${T}/holders`]: json({ items: [
        { address: { hash: "0xAAA", is_contract: false, name: `Po${ZWSP}ol` }, value: "1" },
      ] }),
      [`/addresses/${T}/token-balances`]: json([
        { token: { address_hash: "0xCCC", name: `${RLO}Duke`, symbol: `DUK${ZWSP}E`, decimals: "18", type: "ERC-20" }, value: "5" },
      ]),
    }));
    expect((await src.contract(T)).name).toBe("Duke");
    expect(await src.token(T)).toEqual({ name: "EKTA", symbol: "USDC", decimals: 18, totalSupply: "1", holdersCount: 1 });
    expect((await src.topHolders(T))!.holders[0]!.name).toBe("Pool");
    expect((await src.tokenBalances(T))[0]).toEqual({ address: "0xCCC", name: "Duke", symbol: "DUKE", decimals: 18, value: 5n });
  });

  it("skips malformed array elements instead of throwing", async () => {
    const src = blockscoutSource(API, fakeFetch({
      [`/smart-contracts/${T}`]: json({ is_verified: true, name: "X", abi: null, proxy_type: null, implementations: [null, 7, { address_hash: "0xAAA" }] }),
      [`/tokens/${T}/holders`]: json({ items: [null, "junk", { address: null, value: "5" }, { address: { hash: "0xBBB", is_contract: false, name: null }, value: "-3" }, { address: { hash: "0xCCC", is_contract: false, name: null }, value: "10" }] }),
      [`/addresses/${T}/token-balances`]: json([null, 42, { token: null, value: "1" }, { token: { address_hash: "0xDDD", name: "D", symbol: "D", decimals: "18", type: "ERC-20" }, value: "2.5" }]),
    }));
    expect((await src.contract(T)).implementations).toEqual(["0xAAA"]);
    expect((await src.topHolders(T))!.holders).toEqual([
      { address: "0xBBB", isContract: false, name: null, value: 0n },
      { address: "0xCCC", isContract: false, name: null, value: 10n },
    ]);
    expect(await src.tokenBalances(T)).toEqual([{ address: "0xDDD", name: "D", symbol: "D", decimals: 18, value: 0n }]);
  });

  // N9: measured on the Arc TESTNET explorer on 2026-09-20 for two real unverified ERC-20s —
  // /smart-contracts/<addr> answers 200 with NO `is_verified` field at all (not a 404, not
  // `is_verified: false`); wave F's premise that a missing field always meant "unknown" was wrong
  // for this real shape. The explorer's actual explicit statement lives at /addresses/<addr>
  // instead (`is_contract: true, is_verified: false`), so `contract()` must fall back to it before
  // giving up and calling this "unknown".
  describe("N9 — falls back to /addresses/<addr> when /smart-contracts/<addr> has no is_verified field", () => {
    // The real, complete body shape of the unverified /smart-contracts response (fields present on
    // Blockscout for an unverified contract, minus the is_verified boolean it simply never sends).
    const unverifiedSmartContractsBody = {
      conflicting_implementations: [],
      creation_bytecode: "0x6080604052",
      creation_status: "success",
      deployed_bytecode: "0x6080604052",
      implementations: [],
      proxy_type: null,
    };

    it("resolves verified: false from /addresses/<addr> when /smart-contracts/<addr> has no is_verified field (the real unverified-token shape)", async () => {
      const src = blockscoutSource(API, fakeFetch({
        [`/smart-contracts/${T}`]: json(unverifiedSmartContractsBody),
        [`/addresses/${T}`]: json({ is_contract: true, is_verified: false }),
      }));
      expect(await src.contract(T)).toEqual({ verified: false, name: null, abi: null, proxyType: null, implementations: [] });
    });

    it("does not need /addresses/<addr> at all when /smart-contracts/<addr> already answers explicitly (the real verified-USDC shape)", async () => {
      let addressesCalled = false;
      const fetchFn: typeof fetch = (async (input: RequestInfo | URL) => {
        if (String(input).includes("/addresses/")) addressesCalled = true;
        return fakeFetch({
          [`/smart-contracts/${T}`]: json({ is_verified: true, name: "FiatTokenProxy", abi: [{ type: "function", name: "transfer" }], proxy_type: "eip1967_oz", implementations: [] }),
          [`/addresses/${T}`]: json({ is_contract: true, is_verified: true, name: "FiatTokenProxy", proxy_type: "eip1967_oz" }),
        })(input);
      }) as typeof fetch;
      const src = blockscoutSource(API, fetchFn);
      expect(await src.contract(T)).toEqual({
        verified: true, name: "FiatTokenProxy", abi: [{ type: "function", name: "transfer" }], proxyType: "eip1967_oz", implementations: [],
      });
      expect(addressesCalled).toBe(false);
    });

    it("stays unknown (null) when both endpoints have no record at all (both 404)", async () => {
      const src = blockscoutSource(API, fakeFetch({}));
      expect(await src.contract(T)).toEqual({ verified: null, name: null, abi: null, proxyType: null, implementations: [] });
    });

    it("stays unknown when /addresses/<addr> says this isn't even a contract", async () => {
      const src = blockscoutSource(API, fakeFetch({
        [`/smart-contracts/${T}`]: json(unverifiedSmartContractsBody),
        [`/addresses/${T}`]: json({ is_contract: false }),
      }));
      expect((await src.contract(T)).verified).toBeNull();
    });

    it("stays unknown when /addresses/<addr> is a contract but its body has no is_verified field either", async () => {
      const src = blockscoutSource(API, fakeFetch({
        [`/smart-contracts/${T}`]: json(unverifiedSmartContractsBody),
        [`/addresses/${T}`]: json({ is_contract: true }),
      }));
      expect((await src.contract(T)).verified).toBeNull();
    });

    it("an ExplorerUnavailable from the /addresses/<addr> fallback doesn't sink the fields the first call already got — verified stays null, abi/implementations are kept", async () => {
      const src = blockscoutSource(API, fakeFetch({
        [`/smart-contracts/${T}`]: json({
          conflicting_implementations: [], creation_bytecode: "0x", creation_status: "success", deployed_bytecode: "0x",
          implementations: [{ address_hash: "0x2222222222222222222222222222222222222222" }], proxy_type: "eip1967",
        }),
        [`/addresses/${T}`]: json({}, 503), // outage on the fallback call — not a 404, not a clean answer
      }));
      const info = await src.contract(T);
      expect(info.verified).toBeNull();
      expect(info.proxyType).toBe("eip1967");
      expect(info.implementations).toEqual(["0x2222222222222222222222222222222222222222"]);
    });

    it("also swallows a network-error ExplorerUnavailable from the fallback the same way", async () => {
      const src = blockscoutSource(API, fakeFetch({
        [`/smart-contracts/${T}`]: json(unverifiedSmartContractsBody),
        [`/addresses/${T}`]: new Error("ECONNRESET"),
      }));
      await expect(src.contract(T)).resolves.toMatchObject({ verified: null });
    });
  });
});

describe("blockscoutSource with a Blockscout PRO API key", () => {
  function recording() {
    const calls: { url: string; headers: Headers }[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      return json({ is_verified: true, name: "Duke" });
    }) as typeof fetch;
    return { calls, fetchFn };
  }

  it("sends the key as a bearer header and keeps it out of the URL", async () => {
    const { calls, fetchFn } = recording();
    await blockscoutSource(API, fetchFn, "proapi_secret").contract(T);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${API}/smart-contracts/${T}`);
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer proapi_secret");
    expect(calls[0]!.headers.get("accept")).toBe("application/json");
  });

  it("sends no authorization header without a key", async () => {
    const { calls, fetchFn } = recording();
    await blockscoutSource(API, fetchFn).contract(T);
    expect(calls[0]!.headers.has("authorization")).toBe(false);
  });

  it("treats a refused key (401, 402) as an outage whose message doesn't carry the key", async () => {
    for (const status of [401, 402]) {
      const src = blockscoutSource(API, (async () => json({ error: "Proceed with API key" }, status)) as typeof fetch, "proapi_wrong");
      await expect(src.contract(T)).rejects.toBeInstanceOf(ExplorerUnavailable);
      await expect(src.contract(T)).rejects.toThrow(`Explorer answered ${status}`);
      await expect(src.contract(T)).rejects.not.toThrow(/proapi_wrong/);
    }
  });
});
