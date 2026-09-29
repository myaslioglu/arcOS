import { describe, expect, it } from "vitest";
import { EURC, UNISWAP_V4, USDC, type DexConfig } from "@arcos/chain";
import { findPools } from "../checks";
import { inspect } from "../inspect";
import type { ExtraPool, Finding, InspectInput, Report } from "../types";
import { NATIVE, sqrtRatioAtTick, standardV4Keys, v4PoolId, v4PoolKey } from "../v4";
import { fakeChain, readKey, type FakeChain, type FakePool, type FakeReader } from "./fixtures/chain-fake";

const TOKEN = "0x1111111111111111111111111111111111111111"; // sorts below USDC and EURC
const HIGH = "0x9999999999999999999999999999999999999999"; // sorts above USDC, below EURC
const OTHER = "0x2222222222222222222222222222222222222222";
const POOL = "0x7777777777777777777777777777777777777777";
const V2 = "0x5555555555555555555555555555555555555555";
const V3 = "0x6666666666666666666666666666666666666666";
const HOOK = "0x94f8be2402C0e2eb65F3218a7282A5301371E044";
const PLAIN = "0x63a9059cbb00"; // PUSH4 transfer, STOP: a token with nothing privileged in it
const USD = { address: USDC, symbol: "USDC" };
const EUR = { address: EURC.mainnet, symbol: "EURC" };

const v4Only: DexConfig = { quoteTokens: [USD], v4: UNISWAP_V4 };
const uniswapAll: DexConfig = { quoteTokens: [USD], v2Factory: V2, v3Factory: V3, v3FeeTiers: [3000], v4: UNISWAP_V4 };

const inputFor = (reader: FakeReader, dex: DexConfig, address: `0x${string}` = TOKEN, extraPools?: ExtraPool[]): InspectInput => ({
  address, network: "mainnet", reader, explorer: null, dex, knownLockers: [], explorerBase: "https://explorer.test", extraPools,
});

/** A pool sitting exactly on the sqrt of its tick -1251 with the spacing-10 tier: 422.599842 USDC in range when USDC is currency1 with L = 10^12 (53.223226 when it is currency0). */
const at1251 = (over: Partial<FakePool> = {}): FakePool => ({ sqrtPriceX96: sqrtRatioAtTick(-1251), tick: -1251, liquidity: 10n ** 12n, quote: { amountIn: 1n }, ...over });
const listed = (...pools: [ReturnType<typeof v4PoolKey>, FakePool][]): FakeChain["v4"] => Object.fromEntries(pools.map(([key, pool]) => [v4PoolId(key), pool]));

describe("a DEX config without Uniswap v2 or v3 (testnet has neither)", () => {
  it("asks only the factory it has: v3 alone", async () => {
    const chain = fakeChain({ reads: { [`${V3}.getPool(${TOKEN},${USDC},3000)`]: POOL, [`${USDC}.balanceOf(${POOL})`]: 5_000_000_000n } });
    const scan = await findPools(inputFor(chain, { quoteTokens: [USD], v3Factory: V3, v3FeeTiers: [3000] }));
    expect(scan.pools).toMatchObject([{ address: POOL, version: "v3", quote: "USDC", depth: 5_000_000_000n }]);
    expect(scan.factoriesAnswered).toBe(true);
    expect(chain.asked.map((r) => r.fn)).toEqual(["getPool", "balanceOf"]);
  });

  it("asks only the factory it has: v2 alone", async () => {
    const chain = fakeChain({ reads: { [`${V2}.getPair(${TOKEN},${USDC})`]: POOL, [`${USDC}.balanceOf(${POOL})`]: 5_000_000_000n } });
    const scan = await findPools(inputFor(chain, { quoteTokens: [USD], v2Factory: V2 }));
    expect(scan.pools).toMatchObject([{ address: POOL, version: "v2", depth: 5_000_000_000n }]);
    expect(chain.asked.map((r) => r.fn)).toEqual(["getPair", "balanceOf"]);
  });

  it("asks no v3 question when the factory is named but no fee tier is", async () => {
    const chain = fakeChain();
    const scan = await findPools(inputFor(chain, { quoteTokens: [USD], v3Factory: V3 }));
    expect(scan.pools).toEqual([]);
    expect(chain.asked).toEqual([]);
  });
});

describe("Uniswap v4 discovery", () => {
  it("asks one multicall for every standard key, then one for the depth of the pools that exist: two round trips", async () => {
    const key = v4PoolKey(TOKEN, USDC, 3000, 60);
    const chain = fakeChain({ v4: listed([key, at1251()]) });
    const scan = await findPools(inputFor(chain, v4Only));

    expect(chain.batches).toHaveLength(2);
    const [first, second] = chain.batches;
    expect(first!.calls.map((c) => [c.target, c.fn, c.args[0]])).toEqual(
      standardV4Keys(TOKEN, [USDC, NATIVE]).map((k) => [UNISWAP_V4.stateView, "getSlot0", v4PoolId(k)]),
    );
    expect(second!.calls.map((c) => [c.target, c.fn])).toEqual([[UNISWAP_V4.stateView, "getLiquidity"], [UNISWAP_V4.quoter, "quoteExactOutputSingle"]]);
    expect(second!.calls[0]!.args).toEqual([v4PoolId(key)]);
    expect(scan.pools).toHaveLength(1);
    expect(scan.pools[0]).toMatchObject({ address: UNISWAP_V4.poolManager, version: "v4", quote: "USDC", poolId: v4PoolId(key), key });
  });

  it("stops after one multicall when no standard pool exists, and says the StateView answered", async () => {
    const chain = fakeChain();
    const scan = await findPools(inputFor(chain, v4Only));
    expect(chain.batches).toHaveLength(1);
    expect(scan).toEqual({ pools: [], factoriesAnswered: true, silent: [] });
  });

  it("reads the in-range USDC when the token sorts first and USDC is currency1: the quote asks for currency1 out", async () => {
    const chain = fakeChain({ v4: listed([v4PoolKey(TOKEN, USDC, 500, 10), at1251()]) });
    const scan = await findPools(inputFor(chain, v4Only));
    expect(scan.pools[0]!.depth).toBe(422_599_842n);
    expect(chain.quotes).toEqual([{ poolId: v4PoolId(v4PoolKey(TOKEN, USDC, 500, 10)), zeroForOne: true, exactAmount: 1_000_000_000n }]);
  });

  it("reads the in-range USDC when USDC sorts first and is currency0: the quote asks for currency0 out", async () => {
    const chain = fakeChain({ v4: listed([v4PoolKey(HIGH, USDC, 500, 10), at1251()]) });
    const scan = await findPools(inputFor(chain, v4Only, HIGH));
    expect(scan.pools[0]!.depth).toBe(53_223_226n);
    expect(chain.quotes).toEqual([{ poolId: v4PoolId(v4PoolKey(HIGH, USDC, 500, 10)), zeroForOne: false, exactAmount: 1_000_000_000n }]);
  });

  it("counts native USDC in 18 decimals, shows it in 6, and asks for 1,000 native units out", async () => {
    const key = v4PoolKey(TOKEN, NATIVE, 500, 10);
    const chain = fakeChain({ v4: listed([key, at1251({ liquidity: 10n ** 24n })]) });
    const scan = await findPools(inputFor(chain, v4Only));
    expect(key.currency0).toBe(NATIVE);
    expect(scan.pools[0]).toMatchObject({ quote: "USDC", depth: 53_223_226n, key });
    expect(chain.quotes).toEqual([{ poolId: v4PoolId(key), zeroForOne: false, exactAmount: 1000n * 10n ** 18n }]);
  });

  it("calls a pool liquid exactly when its quote succeeds, whatever the in-range depth", async () => {
    const deepButUnquotable = v4PoolKey(TOKEN, USDC, 500, 10);
    const thinButQuotable = v4PoolKey(TOKEN, USDC, 3000, 60);
    const chain = fakeChain({
      v4: listed([deepButUnquotable, at1251({ liquidity: 10n ** 18n, quote: undefined })], [thinButQuotable, at1251({ liquidity: 10n ** 7n, tick: -1251 })]),
    });
    const { pools } = await findPools(inputFor(chain, v4Only));
    const deep = pools.find((p) => p.poolId === v4PoolId(deepButUnquotable))!;
    const thin = pools.find((p) => p.poolId === v4PoolId(thinButQuotable))!;
    expect(deep.depth).toBeGreaterThan(1_000_000_000n);
    expect(deep.liquid).toBe(false);
    expect(thin.depth).toBeLessThan(1_000_000n);
    expect(thin.liquid).toBe(true);
  });

  it("reads a depth of 0, never a made-up figure, when the liquidity read fails inside an answered multicall", async () => {
    const key = v4PoolKey(TOKEN, USDC, 500, 10);
    const chain = fakeChain({ v4: listed([key, at1251()]), liquidityFails: true });
    const { pools } = await findPools(inputFor(chain, v4Only));
    expect(pools[0]).toMatchObject({ depth: 0n, liquid: true });
  });

  describe("extraPools", () => {
    const hooked = v4PoolKey(TOKEN, USDC, 10000, 200, HOOK);
    const standard = v4PoolKey(TOKEN, USDC, 500, 10);
    const ids = (chain: FakeReader) => chain.batches[0]!.calls.map((c) => c.args[0]);

    it("reads a hooked pool the index knows, next to the standard keys", async () => {
      const chain = fakeChain({ v4: listed([hooked, at1251()]) });
      const scan = await findPools(inputFor(chain, v4Only, TOKEN, [{ version: "v4", key: hooked }]));
      expect(chain.batches[0]!.calls).toHaveLength(11);
      expect(scan.pools).toHaveLength(1);
      expect(scan.pools[0]).toMatchObject({ version: "v4", poolId: v4PoolId(hooked), key: hooked, liquid: true });
    });

    it("ignores a pool it can't use, and a pool it already reads: a duplicate, a standard key, unsorted currencies, another token's pool, a pool against a non-quote, a fee or spacing out of range, a malformed address", async () => {
      const chain = fakeChain({ v4: listed([hooked, at1251()]) });
      const extras: ExtraPool[] = [
        { version: "v4", key: hooked },
        { version: "v4", key: hooked },
        { version: "v4", key: standard },
        { version: "v4", key: { ...hooked, currency0: hooked.currency1, currency1: hooked.currency0 } },
        { version: "v4", key: v4PoolKey(OTHER, USDC, 500, 10, HOOK) },
        { version: "v4", key: v4PoolKey(TOKEN, OTHER, 500, 10, HOOK) },
        { version: "v4", key: { ...hooked, fee: 2 ** 24 } },
        { version: "v4", key: { ...hooked, fee: -1 } },
        { version: "v4", key: { ...hooked, tickSpacing: 0 } },
        { version: "v4", key: { ...hooked, tickSpacing: 32768 } },
        { version: "v4", key: { ...hooked, hooks: "0x123" as `0x${string}` } },
      ];
      const scan = await findPools(inputFor(chain, v4Only, TOKEN, extras));
      expect(chain.batches[0]!.calls).toHaveLength(11);
      expect(new Set(ids(chain)).size).toBe(11);
      expect(scan.pools).toHaveLength(1);
    });

    it("reads at most 50 extra pools", async () => {
      const many = Array.from({ length: 60 }, (_, i): ExtraPool => ({ version: "v4", key: v4PoolKey(TOKEN, USDC, 1 + i, 200, HOOK) }));
      const chain = fakeChain();
      await findPools(inputFor(chain, v4Only, TOKEN, many));
      expect(chain.batches[0]!.calls).toHaveLength(10 + 50);
    });

    it("accepts keys in any letter case", async () => {
      const lowerToken = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const known = v4PoolKey(lowerToken, USDC, 10000, 200, HOOK);
      const chain = fakeChain({ v4: listed([known, at1251()]) });
      const shouty = { currency0: USDC, currency1: lowerToken as `0x${string}`, fee: 10000, tickSpacing: 200, hooks: HOOK.toLowerCase() as `0x${string}` };
      const scan = await findPools(inputFor(chain, v4Only, lowerToken, [{ version: "v4", key: shouty }]));
      expect(scan.pools).toHaveLength(1);
      expect(scan.pools[0]!.key).toEqual(known);
    });
  });

  it("never treats a token as its own quote: inspecting USDC asks about EURC alone", async () => {
    const chain = fakeChain();
    await findPools(inputFor(chain, { quoteTokens: [USD, EUR], v4: UNISWAP_V4 }, USDC));
    expect(chain.batches[0]!.calls.map((c) => c.args[0])).toEqual(standardV4Keys(USDC, [EURC.mainnet]).map(v4PoolId));
  });

  it("calls a StateView that answers 0x silent, not empty: nothing was read, so no pool is ruled out", async () => {
    const chain = fakeChain({ silent: [UNISWAP_V4.stateView] });
    expect(await findPools(inputFor(chain, v4Only))).toEqual({ pools: [], factoriesAnswered: false, silent: ["Uniswap v4"] });
  });

  it("calls a Multicall3 that reverts silent too, without rejecting", async () => {
    const chain = fakeChain({ multicallReverts: true });
    expect(await findPools(inputFor(chain, v4Only))).toEqual({ pools: [], factoriesAnswered: false, silent: ["Uniswap v4"] });
  });

  it("rejects when the multicall fails at the transport level, so the report reads unknown", async () => {
    const chain = fakeChain({ multicallError: new Error("ETIMEDOUT") });
    await expect(findPools(inputFor(chain, v4Only))).rejects.toThrow("ETIMEDOUT");
  });

  it("names the Uniswap v2 and v3 group by what the config has", async () => {
    const chain = fakeChain({ silent: [UNISWAP_V4.stateView] });
    const scan = await findPools(inputFor(chain, uniswapAll));
    expect(scan.silent).toEqual(["Uniswap v2 and v3", "Uniswap v4"]);
  });
});

// --- The findings ---

const explorerNone = null;
const run = (f: FakeChain, dex: DexConfig | null, token: `0x${string}` = TOKEN): Promise<Report> =>
  inspect({
    address: token, network: "mainnet", reader: fakeChain({ code: { [token]: PLAIN }, ...f }), explorer: explorerNone, dex, knownLockers: [],
    explorerBase: "https://explorer.test", now: () => new Date("2026-09-29T00:00:00Z"),
  });
const find = (r: Report, id: Finding["id"]) => r.findings.find((x) => x.id === id)!;

/** Every factory question of `dex` answered "no pool", for `token` against USDC. */
const noPools = (dex: DexConfig, token: string): Record<string, unknown> => ({
  ...(dex.v2Factory ? { [readKey(dex.v2Factory, "getPair", [token, USDC])]: NATIVE } : {}),
  ...Object.fromEntries((dex.v3FeeTiers ?? []).map((fee) => [readKey(dex.v3Factory!, "getPool", [token, USDC, fee]), NATIVE])),
});

describe("the liquidity finding for v4 pools", () => {
  const key = v4PoolKey(TOKEN, USDC, 500, 10);

  it("passes when a 1,000 USDC quote succeeds, and shows what is in range", async () => {
    const r = await run({ v4: listed([key, at1251()]) }, v4Only);
    expect(find(r, "liquidity")).toMatchObject({
      status: "pass",
      title: "1,000 USDC can be swapped out of Uniswap v4",
      evidenceUrl: `https://explorer.test/address/${UNISWAP_V4.poolManager}`,
    });
    expect(find(r, "liquidity").detail).toContain("422 USDC in range at the current price");
    expect(find(r, "liquidity").detail).toContain("1 pool(s) found.");
    expect(JSON.stringify(r)).toContain(TOKEN); // JSON-safe: no bigint anywhere
  });

  it("warns 'thin' when the quote fails, and says so, however much is in range", async () => {
    const r = await run({ v4: listed([key, at1251({ quote: undefined })]) }, v4Only);
    expect(find(r, "liquidity")).toMatchObject({ status: "warn", title: "Thin liquidity" });
    expect(find(r, "liquidity").detail).toBe("Deepest pool has 422 USDC in range, and a 1,000 USDC swap can't be quoted.");
  });

  it("prefers a liquid pool to a deeper one that can't pay out", async () => {
    const other = v4PoolKey(TOKEN, USDC, 3000, 60);
    const r = await run({ v4: listed([key, at1251({ liquidity: 10n ** 12n, quote: undefined })], [other, at1251({ liquidity: 10n ** 7n })]) }, v4Only);
    expect(find(r, "liquidity")).toMatchObject({ status: "pass", title: "1,000 USDC can be swapped out of Uniswap v4" });
    // The figure shown is the liquid pool's (0 USDC in range), not the deeper pool's 422.
    expect(find(r, "liquidity").detail).toContain("0 USDC in range");
    expect(find(r, "liquidity").detail).toContain("2 pool(s) found.");
  });

  it("warns 'no pool' in words that match what was scanned, and admits what v4 discovery can miss", async () => {
    const testnetLike = await run({}, v4Only);
    expect(find(testnetLike, "liquidity")).toMatchObject({ status: "warn", title: "No Uniswap v4 pool found" });
    expect(find(testnetLike, "liquidity").detail).toContain("Looked at Uniswap v4 pools against USDC.");
    expect(find(testnetLike, "liquidity").detail).toContain("a hook or an unusual fee can be missed");

    const uniswap = await run({ reads: noPools(uniswapAll, TOKEN) }, uniswapAll);
    expect(find(uniswap, "liquidity")).toMatchObject({ status: "warn", title: "No Uniswap v2, v3 or v4 pool found" });
  });

  it("is unknown, not 'no pool', while v4 never answered, and still passes on a liquid v3 pool", async () => {
    const silent = { silent: [UNISWAP_V4.stateView] };
    const noPair = await run({ ...silent, reads: noPools(uniswapAll, TOKEN) }, uniswapAll);
    expect(find(noPair, "liquidity")).toMatchObject({ status: "unknown", title: "Couldn't read liquidity pools" });
    expect(find(noPair, "liquidity").detail).toContain("Uniswap v4");
    expect(find(noPair, "lp-lock").status).toBe("unknown");

    const reads = { ...noPools(uniswapAll, TOKEN), [readKey(V3, "getPool", [TOKEN, USDC, 3000])]: POOL, [readKey(USDC, "balanceOf", [POOL])]: 5_000_000_000n };
    const withV3 = await run({ ...silent, reads }, uniswapAll);
    expect(find(withV3, "liquidity")).toMatchObject({ status: "pass", title: "5,000 USDC of liquidity on Uniswap v3" });
  });

  it("says thin liquidity is unknown while a family never answered: the pool it couldn't read may be the deep one", async () => {
    const reads = { ...noPools(uniswapAll, TOKEN), [readKey(V3, "getPool", [TOKEN, USDC, 3000])]: POOL, [readKey(USDC, "balanceOf", [POOL])]: 900_000_000n };
    const r = await run({ silent: [UNISWAP_V4.stateView], reads }, uniswapAll);
    expect(find(r, "liquidity")).toMatchObject({ status: "unknown", title: "Couldn't read liquidity pools" });
    expect(find(r, "liquidity").detail).toContain("900 USDC");
  });

  it("reads unknown when the multicall fails at the transport level", async () => {
    const r = await run({ multicallError: new Error("ETIMEDOUT") }, v4Only);
    expect(find(r, "liquidity")).toMatchObject({ status: "unknown", title: "Couldn't read liquidity pools" });
    expect(r.degraded).toBe(true);
  });
});

describe("the lp-lock finding when the pools aren't Uniswap v2", () => {
  const key = v4PoolKey(TOKEN, USDC, 500, 10);
  const v4Pool = { v4: listed([key, at1251()]) };
  const DEAD = "0x000000000000000000000000000000000000dead";
  const v3Pool = { ...noPools(uniswapAll, TOKEN), [readKey(V3, "getPool", [TOKEN, USDC, 3000])]: POOL, [readKey(USDC, "balanceOf", [POOL])]: 5_000_000_000n };

  it("stays unknown, with a true reason and no fix button, for a token with only v4 pools", async () => {
    const r = await run(v4Pool, v4Only);
    expect(find(r, "lp-lock")).toMatchObject({
      status: "unknown",
      detail: "Only Uniswap v4 pools were found, and liquidity positions in them can't be read without an index yet.",
      fixAppId: null,
    });
  });

  it("names every kind of pool it found: v3 and v4", async () => {
    const r = await run({ ...v4Pool, reads: v3Pool }, uniswapAll);
    expect(find(r, "lp-lock")).toMatchObject({
      status: "unknown",
      detail: "Only Uniswap v3 and Uniswap v4 pools were found, and liquidity positions in them can't be read without an index yet.",
      fixAppId: null,
    });
  });

  it("still judges a token with a v2 pair on that pair's LP tokens, whatever else it has", async () => {
    const reads = {
      ...noPools(uniswapAll, TOKEN),
      [readKey(V2, "getPair", [TOKEN, USDC])]: POOL,
      [readKey(USDC, "balanceOf", [POOL])]: 5_000_000_000n,
      [readKey(POOL, "totalSupply", [])]: 100n,
      [readKey(POOL, "balanceOf", [NATIVE])]: 0n,
      [readKey(POOL, "balanceOf", [DEAD])]: 10n,
    };
    const r = await run({ ...v4Pool, reads }, uniswapAll);
    expect(find(r, "lp-lock")).toMatchObject({ status: "fail", title: "Liquidity isn't locked", fixAppId: "vault" });
  });

  it("keeps 'No pool was found' for a scan that found none, and says which family never answered when one didn't", async () => {
    expect(find(await run({}, v4Only), "lp-lock").detail).toBe("No pool was found.");
    const silent = await run({ silent: [UNISWAP_V4.stateView], reads: noPools(uniswapAll, TOKEN) }, uniswapAll);
    expect(find(silent, "lp-lock")).toMatchObject({ status: "unknown", detail: "Uniswap v4 didn't answer, so a pool there can't be ruled out." });
  });
});
