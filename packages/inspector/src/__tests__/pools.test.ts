import { describe, expect, it } from "vitest";
import { AERODROME, EURC, UNISWAP_V4, USDC, type DexConfig } from "@arcos/chain";
import { bestPool, findPools } from "../checks";
import { inspect } from "../inspect";
import type { ExplorerSource, Holder } from "../explorer";
import type { ExtraPool, Finding, InspectInput, PoolScan, Report } from "../types";
import { NATIVE, QUOTE_CONCURRENCY, QUOTE_GAS, sqrtRatioAtTick, standardV4Keys, v4PoolId, v4PoolKey } from "../v4";
import { EMPTY_INNER_REASON, NOT_ENOUGH_LIQUIDITY, NOT_ENOUGH_LIQUIDITY_OTHER_POOL, NOT_ENOUGH_LIQUIDITY_POOL, POOL_NOT_INITIALIZED } from "./fixtures/quoter-reverts";
import { fakeChain, readKey, v2PairReads, type FakeChain, type FakePool, type FakeReader } from "./fixtures/chain-fake";

const TOKEN = "0x1111111111111111111111111111111111111111"; // sorts below USDC and EURC
const HIGH = "0x9999999999999999999999999999999999999999"; // sorts above USDC, below EURC
const OTHER = "0x2222222222222222222222222222222222222222";
const POOL = "0x7777777777777777777777777777777777777777";
const V2 = "0x5555555555555555555555555555555555555555";
const V3 = "0x6666666666666666666666666666666666666666";
const HOOK = "0x94f8be2402C0e2eb65F3218a7282A5301371E044"; // a real launch hook: flags 0x2044, AFTER_SWAP_RETURNS_DELTA among them
/** Hook addresses carry their permissions in the low 14 bits (v4-core Hooks.sol): 0x80 BEFORE_SWAP, 0x40 AFTER_SWAP, 0x08 BEFORE_SWAP_RETURNS_DELTA, 0x04 AFTER_SWAP_RETURNS_DELTA. */
const hookWith = (flags: string): `0x${string}` => `0x${"1".repeat(36)}${flags}`;
const PLAIN_HOOK = hookWith("00c0"); // swap hooks that return no delta
/** Every kind of hook, down to one with no swap permission at all: any of them leaves a pool undecided. */
const HOOKS = {
  "before-swap (it can add liquidity just in time)": hookWith("0080"),
  "after-swap": hookWith("0040"),
  "before- and after-swap": PLAIN_HOOK,
  "before-swap delta": hookWith("0088"),
  "after-swap delta": hookWith("0044"),
  "both deltas": hookWith("00cc"),
  "no swap permission": hookWith("0001"),
};
const PLAIN = "0x63a9059cbb00"; // PUSH4 transfer, STOP: a token with nothing privileged in it
const USD = { address: USDC, symbol: "USDC" };
const EUR = { address: EURC.mainnet, symbol: "EURC" };

const v4Only: DexConfig = { quoteTokens: [USD], v4: UNISWAP_V4 };
const uniswapAll: DexConfig = { quoteTokens: [USD], v2Factory: V2, v3Factory: V3, v3FeeTiers: [3000], v4: UNISWAP_V4 };
/** What mainnet reads: every family, against USDC and EURC. */
const mainnetLike: DexConfig = { quoteTokens: [USD, EUR], v2Factory: V2, v3Factory: V3, v3FeeTiers: [3000], v4: UNISWAP_V4, aero: AERODROME };

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
    const chain = fakeChain({ reads: { [`${V2}.getPair(${TOKEN},${USDC})`]: POOL, ...v2PairReads(POOL, USDC, TOKEN, 5_000_000_000n) } });
    const scan = await findPools(inputFor(chain, { quoteTokens: [USD], v2Factory: V2 }));
    expect(scan.pools).toMatchObject([{ address: POOL, version: "v2", depth: 5_000_000_000n }]);
    expect(chain.asked.map((r) => r.fn)).toEqual(["getPair", "token0", "getReserves"]);
  });

  it("reads a v2 pair's depth from its reserves, so USDC sent to it without a sync doesn't make it deep", async () => {
    const chain = fakeChain({
      reads: { [`${V2}.getPair(${TOKEN},${USDC})`]: POOL, ...v2PairReads(POOL, USDC, TOKEN, 0n, 0n), [`${USDC}.balanceOf(${POOL})`]: 90_000_000_000n },
    });
    const scan = await findPools(inputFor(chain, { quoteTokens: [USD], v2Factory: V2 }));
    expect(scan.pools).toMatchObject([{ address: POOL, version: "v2", depth: 0n, liquid: false }]);
    expect(chain.asked.map((r) => r.fn)).not.toContain("balanceOf");
  });

  it("never calls a v2 pair liquid with no tokens in its reserves: USDC sent to it and synced", async () => {
    const chain = fakeChain({ reads: { [`${V2}.getPair(${TOKEN},${USDC})`]: POOL, ...v2PairReads(POOL, USDC, TOKEN, 90_000_000_000n, 0n) } });
    const scan = await findPools(inputFor(chain, { quoteTokens: [USD], v2Factory: V2 }));
    expect(scan.pools).toMatchObject([{ address: POOL, version: "v2", depth: 90_000_000_000n, liquid: false }]);
  });

  it("never calls a v2 pair liquid when its quote for the test amount is nothing: a token reserve too small to pay out", async () => {
    // 90,000 USDC against one token unit: 10 USDC buys 0 of it.
    const chain = fakeChain({ reads: { [`${V2}.getPair(${TOKEN},${USDC})`]: POOL, ...v2PairReads(POOL, USDC, TOKEN, 90_000_000_000n, 1n) } });
    const scan = await findPools(inputFor(chain, { quoteTokens: [USD], v2Factory: V2 }));
    expect(scan.pools).toMatchObject([{ liquid: false }]);
    const funded = fakeChain({ reads: { [`${V2}.getPair(${TOKEN},${USDC})`]: POOL, ...v2PairReads(POOL, USDC, TOKEN, 90_000_000_000n, 10n ** 24n) } });
    expect((await findPools(inputFor(funded, { quoteTokens: [USD], v2Factory: V2 }))).pools).toMatchObject([{ liquid: true }]);
  });

  it("reads a v2 pair whose reserves can't be read as holding nothing", async () => {
    const chain = fakeChain({ reads: { [`${V2}.getPair(${TOKEN},${USDC})`]: POOL, [`${USDC}.balanceOf(${POOL})`]: 5_000_000_000n } });
    const scan = await findPools(inputFor(chain, { quoteTokens: [USD], v2Factory: V2 }));
    expect(scan.pools).toMatchObject([{ address: POOL, version: "v2", depth: 0n }]);
  });

  it("asks no v3 question when the factory is named but no fee tier is", async () => {
    const chain = fakeChain();
    const scan = await findPools(inputFor(chain, { quoteTokens: [USD], v3Factory: V3 }));
    expect(scan.pools).toEqual([]);
    expect(chain.asked).toEqual([]);
  });
});

describe("Uniswap v4 discovery", () => {
  it("asks one multicall for every standard key's price and liquidity, then one eth_call per pool that exists for its quote: two round trips", async () => {
    const key = v4PoolKey(TOKEN, USDC, 3000, 60);
    const chain = fakeChain({ v4: listed([key, at1251()]) });
    const scan = await findPools(inputFor(chain, v4Only));

    expect(chain.batches).toHaveLength(1);
    const ids = standardV4Keys(TOKEN, [USDC, NATIVE]).map(v4PoolId);
    expect(chain.batches[0]!.calls.map((c) => [c.target, c.fn, c.args[0]])).toEqual(
      ids.flatMap((id) => [[UNISWAP_V4.stateView, "getSlot0", id], [UNISWAP_V4.stateView, "getLiquidity", id]]),
    );
    // The quote is its own call with its own gas limit, so no other pool's quote can spend the gas it needs.
    expect(chain.quotes).toHaveLength(1);
    expect(chain.quotes[0]).toMatchObject({ poolId: v4PoolId(key), gas: QUOTE_GAS });
    expect(chain.asked.filter((r) => r.fn === "quoteExactOutputSingle")).toHaveLength(1);
    expect(scan.pools).toHaveLength(1);
    expect(scan.pools[0]).toMatchObject({ address: UNISWAP_V4.poolManager, version: "v4", quote: "USDC", poolId: v4PoolId(key), key, liquid: true });
  });

  it("gives every quote the same bounded gas: enough for an honest quote (about 62,500 gas, measured), far under an empty spacing-1 pool's walk (over 20 million)", () => {
    expect(QUOTE_GAS).toBe(2_000_000n);
  });

  it("runs at most QUOTE_CONCURRENCY quotes at once, still one eth_call each, and quotes every pool", async () => {
    const keys = standardV4Keys(TOKEN, [USDC, NATIVE]);
    const chain = fakeChain({ v4: listed(...keys.map((k): [typeof k, FakePool] => [k, at1251()])) });
    let inFlight = 0;
    let most = 0;
    const reader: FakeReader = {
      ...chain,
      read: async (address, abi, fn, args, options) => {
        if (fn !== "quoteExactOutputSingle") return chain.read(address, abi, fn, args, options);
        most = Math.max(most, ++inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return chain.read(address, abi, fn, args, options);
      },
    };
    const scan = await findPools(inputFor(reader, v4Only));
    expect(keys.length).toBeGreaterThan(QUOTE_CONCURRENCY);
    expect(most).toBe(QUOTE_CONCURRENCY);
    expect(chain.quotes).toHaveLength(keys.length);
    expect(scan.pools.map((p) => p.poolId)).toEqual(keys.map(v4PoolId));
    expect(scan.pools.every((p) => p.liquid === true)).toBe(true);
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
    expect(chain.quotes).toEqual([{ poolId: v4PoolId(v4PoolKey(TOKEN, USDC, 500, 10)), zeroForOne: true, exactAmount: 1_000_000_000n, gas: QUOTE_GAS }]);
  });

  it("reads the in-range USDC when USDC sorts first and is currency0: the quote asks for currency0 out", async () => {
    const chain = fakeChain({ v4: listed([v4PoolKey(HIGH, USDC, 500, 10), at1251()]) });
    const scan = await findPools(inputFor(chain, v4Only, HIGH));
    expect(scan.pools[0]!.depth).toBe(53_223_226n);
    expect(chain.quotes).toEqual([{ poolId: v4PoolId(v4PoolKey(HIGH, USDC, 500, 10)), zeroForOne: false, exactAmount: 1_000_000_000n, gas: QUOTE_GAS }]);
  });

  it("counts native USDC in 18 decimals, shows it in 6, and asks for 1,000 native units out", async () => {
    const key = v4PoolKey(TOKEN, NATIVE, 500, 10);
    const chain = fakeChain({ v4: listed([key, at1251({ liquidity: 10n ** 24n })]) });
    const scan = await findPools(inputFor(chain, v4Only));
    expect(key.currency0).toBe(NATIVE);
    expect(scan.pools[0]).toMatchObject({ quote: "USDC", depth: 53_223_226n, key });
    expect(chain.quotes).toEqual([{ poolId: v4PoolId(key), zeroForOne: false, exactAmount: 1000n * 10n ** 18n, gas: QUOTE_GAS }]);
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
    const hooked = v4PoolKey(TOKEN, USDC, 10000, 200, PLAIN_HOOK);
    const standard = v4PoolKey(TOKEN, USDC, 500, 10);
    const ids = (chain: FakeReader) => chain.batches[0]!.calls.filter((c) => c.fn === "getSlot0").map((c) => c.args[0]);
    const slots = (chain: FakeReader) => chain.batches[0]!.calls.filter((c) => c.fn === "getSlot0");

    it("reads a hooked pool the index knows, next to the standard keys", async () => {
      const chain = fakeChain({ v4: listed([hooked, at1251()]) });
      const scan = await findPools(inputFor(chain, v4Only, TOKEN, [{ version: "v4", key: hooked }]));
      expect(slots(chain)).toHaveLength(11);
      expect(scan.pools).toHaveLength(1);
      expect(scan.pools[0]).toMatchObject({ version: "v4", poolId: v4PoolId(hooked), key: hooked, liquid: null, undecided: "hook" });
    });

    it("ignores a pool it can't use, and a pool it already reads: a duplicate, a standard key, unsorted currencies, another token's pool, a pool against a non-quote, a fee or spacing out of range, a malformed address", async () => {
      const chain = fakeChain({ v4: listed([hooked, at1251()]) });
      const extras: ExtraPool[] = [
        { version: "v4", key: hooked },
        { version: "v4", key: hooked },
        { version: "v4", key: standard },
        { version: "v4", key: { ...hooked, currency0: hooked.currency1, currency1: hooked.currency0 } },
        { version: "v4", key: v4PoolKey(OTHER, USDC, 500, 10, PLAIN_HOOK) },
        { version: "v4", key: v4PoolKey(TOKEN, OTHER, 500, 10, PLAIN_HOOK) },
        { version: "v4", key: { ...hooked, fee: 2 ** 24 } },
        { version: "v4", key: { ...hooked, fee: -1 } },
        { version: "v4", key: { ...hooked, tickSpacing: 0 } },
        { version: "v4", key: { ...hooked, tickSpacing: 32768 } },
        { version: "v4", key: { ...hooked, hooks: "0x123" as `0x${string}` } },
      ];
      const scan = await findPools(inputFor(chain, v4Only, TOKEN, extras));
      expect(slots(chain)).toHaveLength(11);
      expect(new Set(ids(chain)).size).toBe(11);
      expect(scan.pools).toHaveLength(1);
    });

    it("reads at most 50 extra pools", async () => {
      const many = Array.from({ length: 60 }, (_, i): ExtraPool => ({ version: "v4", key: v4PoolKey(TOKEN, USDC, 1 + i, 200, PLAIN_HOOK) }));
      const chain = fakeChain();
      await findPools(inputFor(chain, v4Only, TOKEN, many));
      expect(slots(chain)).toHaveLength(10 + 50);
    });

    it("counts the 50-pool cap after validating and deduplicating, so junk in front doesn't use it up", async () => {
      const junk: ExtraPool[] = [
        ...Array.from({ length: 12 }, (): ExtraPool => ({ version: "v4", key: { ...hooked, tickSpacing: 0 } })),
        { version: "v4", key: standard },
        { version: "v4", key: standard },
      ];
      const valid = Array.from({ length: 60 }, (_, i): ExtraPool => ({ version: "v4", key: v4PoolKey(TOKEN, USDC, 1 + i, 200, PLAIN_HOOK) }));
      const chain = fakeChain();
      await findPools(inputFor(chain, v4Only, TOKEN, [...junk, ...valid, ...valid]));
      expect(slots(chain)).toHaveLength(10 + 50);
      expect(new Set(ids(chain)).size).toBe(60);
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
    expect(chain.batches[0]!.calls.filter((c) => c.fn === "getSlot0").map((c) => c.args[0])).toEqual(standardV4Keys(USDC, [EURC.mainnet]).map(v4PoolId));
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

const run = (f: FakeChain, dex: DexConfig | null, token: `0x${string}` = TOKEN, explorer: ExplorerSource | null = null, extraPools?: ExtraPool[]): Promise<Report> =>
  inspect({
    address: token, network: "mainnet", reader: fakeChain({ code: { [token]: PLAIN }, ...f }), explorer, dex, knownLockers: [],
    explorerBase: "https://explorer.test", now: () => new Date("2026-09-29T00:00:00Z"), extraPools,
  });
const find = (r: Report, id: Finding["id"]) => r.findings.find((x) => x.id === id)!;

/** Every factory question of `dex` for `token` answered "no pool": the zero address, which is what a factory says. */
const noPools = (dex: DexConfig, token: string): Record<string, unknown> => {
  const quotes = dex.quoteTokens.map((q) => q.address).filter((q) => q.toLowerCase() !== token.toLowerCase());
  return Object.fromEntries(
    quotes.flatMap((q) => [
      ...(dex.v2Factory ? [[readKey(dex.v2Factory, "getPair", [token, q]), NATIVE]] : []),
      ...(dex.v3Factory ? (dex.v3FeeTiers ?? []).map((fee) => [readKey(dex.v3Factory!, "getPool", [token, q, fee]), NATIVE]) : []),
      ...(dex.aero ? dex.aero.tickSpacings.map((spacing) => [readKey(dex.aero!.clFactory, "getPool", [token, q, spacing]), NATIVE]) : []),
    ]),
  );
};

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

describe("onPools: the pool lookup, handed to the caller", () => {
  const key = v4PoolKey(TOKEN, USDC, 500, 10);
  const withHook = (onPools: InspectInput["onPools"]) =>
    inspect({
      address: TOKEN, network: "mainnet", reader: fakeChain({ code: { [TOKEN]: PLAIN }, v4: listed([key, at1251()]) }), explorer: null,
      dex: v4Only, knownLockers: [], explorerBase: "https://explorer.test", now: () => new Date("2026-09-29T00:00:00Z"), onPools,
    });

  it("gets the very scan the findings were made from, once, and bestPool picks the pool the liquidity finding names", async () => {
    const seen: (PoolScan | null)[] = [];
    const r = await withHook((scan) => seen.push(scan));
    expect(seen).toHaveLength(1);
    const pool = bestPool(seen[0]!.pools);
    expect(pool).toMatchObject({ version: "v4", liquid: true, poolId: v4PoolId(key) });
    expect(find(r, "liquidity").status).toBe("pass");
  });

  it("gets null when the lookup failed, and a hook that throws changes nothing in the report", async () => {
    const seen: (PoolScan | null)[] = [];
    const failing = await inspect({
      address: TOKEN, network: "mainnet", reader: fakeChain({ code: { [TOKEN]: PLAIN }, multicallError: new Error("ETIMEDOUT") }), explorer: null,
      dex: v4Only, knownLockers: [], explorerBase: "https://explorer.test", onPools: (scan) => seen.push(scan),
    });
    expect(seen).toEqual([null]);
    expect(find(failing, "liquidity").status).toBe("unknown");
    const quiet = await withHook(undefined);
    const loud = await withHook(() => {
      throw new Error("the caller's own bug");
    });
    expect(loud.findings).toEqual(quiet.findings);
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

describe("Aerodrome Slipstream pools", () => {
  const at = (quote: string, spacing: number) => readKey(AERODROME.clFactory, "getPool", [TOKEN, quote, spacing]);
  const aeroCalls = (chain: FakeReader) => chain.batches.find((b) => b.calls[0]!.target === AERODROME.clFactory)!.calls;

  it("asks the factory once for every quote and tick spacing, then reads the quote balance of each pool it found", async () => {
    const chain = fakeChain({ reads: { ...noPools(mainnetLike, TOKEN), [at(USDC, 50)]: POOL, [readKey(USDC, "balanceOf", [POOL])]: 5_000_000_000n } });
    const scan = await findPools(inputFor(chain, mainnetLike));

    expect(aeroCalls(chain).map((c) => [c.fn, ...c.args.map((a) => String(a).toLowerCase())])).toEqual(
      [USDC, EURC.mainnet].flatMap((q) => AERODROME.tickSpacings.map((spacing) => ["getPool", TOKEN, q.toLowerCase(), String(spacing)])),
    );
    expect(scan.pools).toEqual([{ address: POOL, version: "aero", quote: "USDC", depth: 5_000_000_000n, liquid: true }]);
    expect(chain.asked.filter((r) => r.fn === "balanceOf").map((r) => r.address)).toEqual([USDC]);
    expect(scan.silent).toEqual([]);
  });

  it("reads each pool's balance of its own quote token, and calls a pool under 1,000 units thin", async () => {
    const POOL2 = "0x8888888888888888888888888888888888888888";
    const reads = {
      ...noPools(mainnetLike, TOKEN),
      [at(USDC, 50)]: POOL,
      [at(EURC.mainnet, 2000)]: POOL2,
      [readKey(USDC, "balanceOf", [POOL])]: 5_000_000_000n,
      [readKey(EURC.mainnet, "balanceOf", [POOL2])]: 300_000_000n,
    };
    const { pools } = await findPools(inputFor(fakeChain({ reads }), mainnetLike));
    expect(pools).toEqual([
      { address: POOL, version: "aero", quote: "USDC", depth: 5_000_000_000n, liquid: true },
      { address: POOL2, version: "aero", quote: "EURC", depth: 300_000_000n, liquid: false },
    ]);
  });

  it("names Aerodrome, not Uniswap, in the liquidity finding", async () => {
    const reads = { ...noPools(mainnetLike, TOKEN), [at(USDC, 50)]: POOL, [readKey(USDC, "balanceOf", [POOL])]: 5_000_000_000n };
    const r = await run({ reads }, mainnetLike);
    expect(find(r, "liquidity")).toMatchObject({ status: "pass", title: "5,000 USDC of liquidity on Aerodrome", evidenceUrl: `https://explorer.test/address/${POOL}` });
    expect(find(r, "lp-lock")).toMatchObject({ status: "unknown", fixAppId: null });
    expect(find(r, "lp-lock").detail).toBe("Only Aerodrome pools were found, and liquidity positions in them can't be read without an index yet.");
  });

  it("says thin liquidity when the pool holds under 1,000 units", async () => {
    const reads = { ...noPools(mainnetLike, TOKEN), [at(USDC, 50)]: POOL, [readKey(USDC, "balanceOf", [POOL])]: 900_000_000n };
    expect(find(await run({ reads }, mainnetLike), "liquidity")).toMatchObject({ status: "warn", title: "Thin liquidity", detail: "Deepest pool holds 900 USDC." });
  });

  it("words 'no pool' for mainnet's whole registry, Aerodrome included", async () => {
    const r = await run({ reads: noPools(mainnetLike, TOKEN) }, mainnetLike);
    expect(find(r, "liquidity")).toMatchObject({ status: "warn", title: "No Uniswap or Aerodrome pool found" });
    expect(find(r, "liquidity").detail).toContain("Looked at Uniswap v2, Uniswap v3, Uniswap v4 and Aerodrome pools against USDC and EURC.");
  });

  it("is unknown, not 'no pool', while the factory has no code, and still passes on a liquid pool from another family", async () => {
    const silent = { silent: [AERODROME.clFactory] };
    const none = await run({ ...silent, reads: noPools(mainnetLike, TOKEN) }, mainnetLike);
    expect(find(none, "liquidity")).toMatchObject({ status: "unknown", title: "Couldn't read liquidity pools", detail: "Aerodrome didn't answer, so a pool there can't be ruled out." });

    const reads = { ...noPools(mainnetLike, TOKEN), [readKey(V3, "getPool", [TOKEN, USDC, 3000])]: POOL, [readKey(USDC, "balanceOf", [POOL])]: 5_000_000_000n };
    expect(find(await run({ ...silent, reads }, mainnetLike), "liquidity")).toMatchObject({ status: "pass", title: "5,000 USDC of liquidity on Uniswap v3" });
  });

  it("names every family a reverting Multicall3 silences, in the order they were configured", async () => {
    const scan = await findPools(inputFor(fakeChain({ multicallReverts: true, reads: noPools(mainnetLike, TOKEN) }), mainnetLike));
    expect(scan.silent).toEqual(["Uniswap v4", "Aerodrome"]);
    expect(scan.factoriesAnswered).toBe(true); // v2 and v3 answered
  });

  it("never treats a token as its own quote: inspecting EURC asks only about USDC", async () => {
    const chain = fakeChain({ reads: noPools(mainnetLike, EURC.mainnet) });
    await findPools(inputFor(chain, mainnetLike, EURC.mainnet));
    expect(chain.asked.filter((r) => r.fn === "getPair").map((r) => r.args.map((a) => String(a).toLowerCase()))).toEqual([[EURC.mainnet.toLowerCase(), USDC]]);
    const aero = chain.batches.find((b) => b.calls[0]!.target === AERODROME.clFactory)!.calls;
    expect(aero).toHaveLength(AERODROME.tickSpacings.length);
    expect(new Set(aero.map((c) => String(c.args[1]).toLowerCase()))).toEqual(new Set([USDC]));
  });

  it("reads no Aerodrome unless the config names it", async () => {
    const chain = fakeChain({ reads: noPools(uniswapAll, TOKEN) });
    await findPools(inputFor(chain, uniswapAll));
    expect(chain.batches.some((b) => b.calls.some((c) => c.target === AERODROME.clFactory))).toBe(false);
    const legacy = fakeChain({ reads: noPools(uniswapAll, TOKEN) });
    await findPools(inputFor(legacy, { quoteTokens: [USD], v2Factory: V2, v3Factory: V3, v3FeeTiers: [3000] }));
    expect(legacy.batches).toHaveLength(0);
  });
});

describe("the holders finding", () => {
  /** An explorer that lists these holders as the whole list, of a token with a supply of 1,000. */
  const holdersOf = (holders: Holder[]): ExplorerSource => ({
    contract: async () => ({ verified: true, name: "T", abi: null, proxyType: null, implementations: [] }),
    token: async () => ({ name: "Token", symbol: "TKN", decimals: 18, totalSupply: "1000", holdersCount: holders.length }),
    topHolders: async () => ({ holders, complete: true }),
    tokenBalances: async () => [],
  });
  const wallet = (address: string, value: bigint): Holder => ({ address: address as `0x${string}`, isContract: false, name: null, value });

  it("leaves out the v4 PoolManager: it holds the tokens of every v4 pool, and no wallet's", async () => {
    const explorer = holdersOf([wallet(UNISWAP_V4.poolManager, 700n), wallet(OTHER, 300n)]);
    const r = await run({}, v4Only, TOKEN, explorer);
    expect(find(r, "holders")).toMatchObject({ status: "warn", title: "The only wallet holds 30%" });
  });

  it("leaves it out whether or not a v4 pool of this token was found", async () => {
    const key = v4PoolKey(TOKEN, USDC, 500, 10);
    const explorer = holdersOf([wallet(UNISWAP_V4.poolManager, 700n), wallet(OTHER, 300n)]);
    const r = await run({ v4: listed([key, at1251()]) }, v4Only, TOKEN, explorer);
    expect(find(r, "holders")).toMatchObject({ status: "warn", title: "The only wallet holds 30%" });
  });

  it("counts an address as a wallet where no PoolManager is configured for it", async () => {
    const explorer = holdersOf([wallet(UNISWAP_V4.poolManager, 700n), wallet(OTHER, 300n)]);
    const r = await run({ reads: noPools(uniswapAll, TOKEN) }, { quoteTokens: [USD], v2Factory: V2, v3Factory: V3, v3FeeTiers: [3000] }, TOKEN, explorer);
    expect(find(r, "holders")).toMatchObject({ status: "fail", title: "All 2 wallets hold 100%" });
  });
});

// --- What a quote's outcome means ---

describe("a v4 quote's outcome", () => {
  // The USDC/EURC 0.05% pool, so the pinned revert bytes (read live for exactly that pool id) apply as they are.
  const eurcPool = v4PoolKey(USDC, EURC.mainnet, 500, 10);
  const scanOf = async (pool: FakePool, key = eurcPool) => {
    const chain = fakeChain({ v4: listed([key, pool]) });
    return (await findPools(inputFor(chain, v4Only, EURC.mainnet, [{ version: "v4", key }]))).pools[0]!;
  };

  it("pins the fixture to the pool it was read for", () => {
    expect(v4PoolId(eurcPool)).toBe(NOT_ENOUGH_LIQUIDITY_POOL);
  });

  it("can't pay only when the quoter says the pool's own liquidity ran out: NotEnoughLiquidity with this pool's id", async () => {
    const pool = await scanOf(at1251({ quote: { reverts: NOT_ENOUGH_LIQUIDITY } }));
    expect(pool).toMatchObject({ liquid: false });
    expect(pool.undecided).toBeUndefined();
  });

  it.each<[string, NonNullable<FakePool["quote"]>]>([
    ["an empty inner reason (the inner call ran out of gas)", { reverts: EMPTY_INNER_REASON }],
    ["an uninitialised pool's reason", { reverts: POOL_NOT_INITIALIZED }],
    ["another pool's NotEnoughLiquidity", { reverts: NOT_ENOUGH_LIQUIDITY_OTHER_POOL }],
    ["a bare Error(string) selector", { reverts: "0x08c379a0" as const }],
    ["a transport failure", { fails: new Error("ETIMEDOUT") }],
  ])("leaves the pool unquoted, never thin, on %s", async (_, quote) => {
    const pool = await scanOf(at1251({ quote }));
    expect(pool).toMatchObject({ liquid: null, undecided: "quote-unavailable" });
  });

  it("is liquid from a quote only for a pool without a hook", async () => {
    expect(await scanOf(at1251(), v4PoolKey(USDC, EURC.mainnet, 500, 10, NATIVE))).toMatchObject({ liquid: true });
  });

  // A hook runs inside the swap the quote simulates, so whatever the quote says is the hook's say as much as the pool's. A
  // before-swap hook can add liquidity just in time and take it out again, a returns-delta hook can claim the output without
  // the pool paying it (V4Quoter reverts before the settlement check), and any swap hook can revert with NotEnoughLiquidity.
  it.each(Object.entries(HOOKS))("leaves a pool undecided whatever its quote would say, and doesn't ask, when its hook is %s", async (_, hooks) => {
    const key = v4PoolKey(USDC, EURC.mainnet, 10000, 200, hooks);
    for (const quote of [undefined, { reverts: NOT_ENOUGH_LIQUIDITY }, { amountIn: 1n }] as const) {
      const chain = fakeChain({ v4: listed([key, at1251({ quote })]) });
      const [pool] = (await findPools(inputFor(chain, v4Only, EURC.mainnet, [{ version: "v4", key }]))).pools;
      expect(pool).toMatchObject({ liquid: null, undecided: "hook" });
      expect(pool!.depth).toBeGreaterThan(0n);
      expect(chain.quotes).toEqual([]);
    }
  });

  it("gives each pool's quote its own failure: one that fails leaves the others' answers alone", async () => {
    const a = v4PoolKey(USDC, EURC.mainnet, 500, 10);
    const b = v4PoolKey(USDC, EURC.mainnet, 3000, 60);
    const chain = fakeChain({ v4: listed([a, at1251({ quote: { fails: new Error("ETIMEDOUT") } })], [b, at1251()]) });
    const { pools } = await findPools(inputFor(chain, v4Only, EURC.mainnet));
    expect(pools.map((p) => [p.poolId, p.liquid])).toEqual([[v4PoolId(a), null], [v4PoolId(b), true]]);
  });

  it("keeps the other families' pools when every v4 quote fails", async () => {
    const reads = { ...noPools(mainnetLike, TOKEN), [readKey(V3, "getPool", [TOKEN, USDC, 3000])]: POOL, [readKey(USDC, "balanceOf", [POOL])]: 5_000_000_000n };
    const key = v4PoolKey(TOKEN, USDC, 500, 10);
    const chain = fakeChain({ reads, v4: listed([key, at1251({ quote: { fails: new Error("ETIMEDOUT") } })]) });
    const scan = await findPools(inputFor(chain, mainnetLike));
    expect(scan.pools.map((p) => p.version)).toEqual(["v3", "v4"]);
    expect(scan.silent).toEqual([]);
  });
});

describe("the liquidity finding when a v4 pool's liquidity is undecided", () => {
  const key = v4PoolKey(TOKEN, USDC, 500, 10);
  const delta = v4PoolKey(TOKEN, USDC, 10000, 200, HOOK);
  const v3Pool = { ...noPools(uniswapAll, TOKEN), [readKey(V3, "getPool", [TOKEN, USDC, 3000])]: POOL, [readKey(USDC, "balanceOf", [POOL])]: 5_000_000_000n };
  const extra: ExtraPool[] = [{ version: "v4", key: delta }];
  const runWith = (f: FakeChain, dex: DexConfig, extraPools?: ExtraPool[]) =>
    inspect({
      address: TOKEN, network: "mainnet", reader: fakeChain({ code: { [TOKEN]: PLAIN }, ...f }), explorer: null, dex, knownLockers: [], explorerBase: "https://explorer.test",
      extraPools,
    });

  it("reads unknown when the only pool has a hook", async () => {
    const r = await runWith({ v4: listed([delta, at1251()]) }, v4Only, extra);
    expect(find(r, "liquidity")).toMatchObject({ status: "unknown", title: "Couldn't verify Uniswap v4 liquidity" });
    expect(find(r, "liquidity").detail).toContain("has a hook, which can change what a swap pays");
    expect(find(r, "liquidity").detail).toContain("a quote can't judge its liquidity");
  });

  it("reads unknown, never thin, when a quote couldn't be read", async () => {
    const r = await runWith({ v4: listed([key, at1251({ quote: { reverts: EMPTY_INNER_REASON } })]) }, v4Only);
    expect(find(r, "liquidity")).toMatchObject({ status: "unknown", title: "Couldn't verify Uniswap v4 liquidity" });
    expect(find(r, "liquidity").detail).toContain("didn't answer");
  });

  it("still passes when another pool is liquid, and warns thin only when every pool decisively can't pay", async () => {
    const pass = await runWith({ reads: v3Pool, v4: listed([delta, at1251()]) }, uniswapAll, extra);
    expect(find(pass, "liquidity")).toMatchObject({ status: "pass", title: "5,000 USDC of liquidity on Uniswap v3" });

    const thin = await runWith({ v4: listed([key, at1251({ quote: undefined })]) }, v4Only);
    expect(find(thin, "liquidity")).toMatchObject({ status: "warn", title: "Thin liquidity" });

    // A hooked pool's "can't pay" is the hook's as much as the pool's, so it is never the evidence for "thin".
    for (const hooked of [at1251({ quote: undefined }), at1251()]) {
      const mixed = await runWith({ v4: listed([key, at1251({ quote: undefined })], [delta, hooked]) }, v4Only, extra);
      expect(find(mixed, "liquidity").status).toBe("unknown");
    }
  });
});

describe("the lp-lock finding beside a deeper pool", () => {
  const DEAD = "0x000000000000000000000000000000000000dead";
  const PAIR = "0x4444444444444444444444444444444444444444";
  const both = { quoteTokens: [USD], v2Factory: V2, v3Factory: V3, v3FeeTiers: [3000], v4: UNISWAP_V4, aero: AERODROME } satisfies DexConfig;
  const pair = (lpBurned: bigint, depth: bigint) => ({
    ...noPools(both, TOKEN),
    [readKey(V2, "getPair", [TOKEN, USDC])]: PAIR,
    ...v2PairReads(PAIR, USDC, TOKEN, depth),
    [readKey(PAIR, "totalSupply", [])]: 100n,
    [readKey(PAIR, "balanceOf", [NATIVE])]: 0n,
    [readKey(PAIR, "balanceOf", [DEAD])]: lpBurned,
  });
  const lpLock = async (f: FakeChain, extraPools?: ExtraPool[]) => find(await run(f, both, TOKEN, null, extraPools), "lp-lock");
  const v3With = (depth: bigint) => ({ [readKey(V3, "getPool", [TOKEN, USDC, 3000])]: POOL, [readKey(USDC, "balanceOf", [POOL])]: depth });
  const aeroWith = (depth: bigint) => ({ [readKey(AERODROME.clFactory, "getPool", [TOKEN, USDC, 50])]: POOL, [readKey(USDC, "balanceOf", [POOL])]: depth });
  const key = v4PoolKey(TOKEN, USDC, 500, 10);

  it("passes when the burned pair is the token's deepest pool (as it always did)", async () => {
    expect(await lpLock({ reads: { ...pair(100n, 5_000_000_000n), ...v3With(500_000_000n) } })).toMatchObject({ status: "pass", fixAppId: null });
    expect(await lpLock({ reads: pair(100n, 5_000_000_000n) })).toMatchObject({ status: "pass" });
  });

  it("reads unknown when a deeper Uniswap v3 pool's positions can't be read, though the small pair is burned", async () => {
    const f = await lpLock({ reads: { ...pair(100n, 500_000_000n), ...v3With(5_000_000_000n) } });
    expect(f).toMatchObject({ status: "unknown", fixAppId: null, detail: "The deepest pool is a Uniswap v3 position, which can't be read without an index yet." });
  });

  it("says the same of a deeper Aerodrome pool", async () => {
    const f = await lpLock({ reads: { ...pair(100n, 500_000_000n), ...aeroWith(5_000_000_000n) } });
    expect(f).toMatchObject({ status: "unknown", detail: "The deepest pool is an Aerodrome position, which can't be read without an index yet." });
  });

  it("can't rank a v4 pool by its in-range figure, so a v4 pool that may hold more blocks the pass", async () => {
    const liquid = await lpLock({ reads: pair(100n, 5_000_000_000n), v4: listed([key, at1251()]) });
    expect(liquid).toMatchObject({ status: "unknown", fixAppId: null });
    expect(liquid.detail).toBe("A Uniswap v4 pool that may hold more than this v2 pair sits beside it, and positions in it can't be read without an index yet.");
    const undecided = await lpLock({ reads: pair(100n, 5_000_000_000n), v4: listed([key, at1251({ quote: { reverts: EMPTY_INNER_REASON } })]) });
    expect(undecided.status).toBe("unknown");
  });

  it("never passes beside a hooked v4 pool, even one whose hook says it can't pay", async () => {
    const hooked = v4PoolKey(TOKEN, USDC, 10000, 200, HOOKS["before-swap (it can add liquidity just in time)"]);
    const f = await lpLock({ reads: pair(100n, 5_000_000_000n), v4: listed([hooked, at1251({ quote: undefined })]) }, [{ version: "v4", key: hooked }]);
    expect(f).toMatchObject({ status: "unknown", fixAppId: null });
  });

  it("passes beside a v4 pool that decisively can't pay, when the pair is liquid", async () => {
    expect((await lpLock({ reads: pair(100n, 5_000_000_000n), v4: listed([key, at1251({ quote: undefined })]) })).status).toBe("pass");
  });

  it("reads unknown beside a v4 pool that can't pay when the pair can't pay 1,000 either: neither is known to be the deepest", async () => {
    const f = await lpLock({ reads: pair(100n, 500_000_000n), v4: listed([key, at1251({ quote: undefined })]) });
    expect(f).toMatchObject({ status: "unknown", fixAppId: null });
  });

  it("still fails an unlocked pair whatever else exists: the v2 LP is a fact", async () => {
    const f = await lpLock({ reads: { ...pair(10n, 500_000_000n), ...v3With(5_000_000_000n) } });
    expect(f).toMatchObject({ status: "fail", title: "Liquidity isn't locked", fixAppId: "vault" });
  });

  it("treats an equally deep pool as no rival", async () => {
    expect((await lpLock({ reads: { ...pair(100n, 5_000_000_000n), ...v3With(5_000_000_000n) } })).status).toBe("pass");
  });
});
