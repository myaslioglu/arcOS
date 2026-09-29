/**
 * Live, read-only checks against Arc mainnet (https://rpc.mainnet.arc.io): the addresses the pool checks rely on, and v4 and
 * Aerodrome discovery against real pools. Not part of `npm test`; run it with `npm run test:live -w @arcos/inspector`.
 * Only `eth_call` and `eth_getCode` are sent, one at a time, 400 ms apart, with a back-off when the node says -32005.
 *
 * Existence is permanent, market state is not. A v4 pool, once initialised, stays initialised, so the checks that a pool is
 * found hold for good. Two established pools (the USDC/EURC v4 pool and the WETH/USDC Aerodrome pool) also assert that they
 * can pay out; if one is ever drained, pick another from PoolManager `Initialize` logs or the Aerodrome factory's `allPools`
 * and record its block here. Launch pools move within minutes (the native pool below had no liquidity 25 minutes after it was
 * recorded), so those only assert that they are found and read.
 */
import { createPublicClient, http, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import { AERODROME, CHAINS, DEX, EURC, MULTICALL3, UNISWAP_V4, USDC, type DexConfig } from "@arcos/chain";
import { findPools } from "../src/checks";
import { inspect } from "../src/inspect";
import { viemReader } from "../src/reader";
import type { ChainReader, ExtraPool, InspectInput, PoolScan } from "../src/types";
import { NATIVE, quoteInRange, quoterAbi, sqrtRatioAtTick, stateViewAbi, v4PoolId, v4PoolKey } from "../src/v4";

const RPC = "https://rpc.mainnet.arc.io";
const GAP_MS = 400;

// --- Pinned pools (block = when it was read or emitted; Arc mainnet, 2026-09-29) ---

/** Uniswap v4, USDC (0x3600) / EURC, 0.05%, tick spacing 10, no hooks. Read at block 23,412,422: sqrtPriceX96 74424664170632289860573093359,
 * tick -1251, liquidity 5,555,951,229,628, 281.248329 USDC in range; a quote for 1,000 USDC out cost 883,020,339 EURC-raw. */
const USDC_EURC_POOL = "0xeb0fd02fb8044d5514fb6e165ee134fd547eff0378bb33b76f4b81d8b03bd1ae";

/** Uniswap v4, native USDC / 0x5101f7e2…e9cf, 0.25%, spacing 50, no hooks. `Initialize` at block 23,410,877 with a working 1,000 USDC
 * quote; no liquidity at block 23,412,354. */
const NATIVE_POOL = { id: "0xa930234d875e21c35f1da88ed4a2ff27ea78091fcadb5708f68c355b61010b4a", token: "0x5101f7e21278290f0eabEa8cAfFbDF301646e9cf" } as const;

/** Uniswap v4, USDC / 0xb6C3…87Aa, 1%, spacing 200, hooked by 0x94f8…E044. `Initialize` at block 23,410,676, quotable then. */
const HOOKED_POOL = {
  id: "0x1f1f87b6d58383d7d25b7b6bb2af557ca8f85545379f00cf8741ea3363838019",
  key: v4PoolKey(USDC, "0xb6C3cC01Ad7D6f786E791E317d47aa62A75487Aa", 10000, 200, "0x94f8be2402C0e2eb65F3218a7282A5301371E044"),
} as const;

/** Aerodrome Slipstream, WETH / USDC, tick spacing 50. Read around block 23,411,000: tick -197361, liquidity 180,341,565,912,525,016, 521,640.40 USDC. */
const WETH = "0x128cC466B61f542da60c70e3aA11c10e19B84EDB";
const AERO_WETH_POOL = "0x6F302dECb49fB30B2D2c609BDD16e04e7Dd096FC";

// --- The client, and the pacing every call goes through ---

const client = createPublicClient({ chain: CHAINS.mainnet, transport: http(RPC, { retryCount: 0, timeout: 30_000 }) });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let nextSlot = 0;

/** One call at a time, `GAP_MS` apart; a rate-limit answer (-32005) waits and tries again. */
async function paced<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const now = Date.now();
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + GAP_MS;
    if (slot > now) await sleep(slot - now);
    try {
      return await call();
    } catch (e) {
      const said = `${(e as Error)?.message ?? ""} ${(e as { details?: string })?.details ?? ""}`;
      if (attempt < 5 && /-32005|rate limit/i.test(said)) {
        await sleep(1_500 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
}

const inner = viemReader(client);
const reader: ChainReader = {
  getCode: (a) => paced(() => inner.getCode(a)),
  getStorageAt: (a, slot) => paced(() => inner.getStorageAt(a, slot)),
  read: (a, abi, fn, args) => paced(() => inner.read(a, abi, fn, args)),
  blockNumber: () => paced(() => inner.blockNumber()),
};

const input = (address: `0x${string}`, dex: DexConfig | null, extraPools?: ExtraPool[]): InspectInput => ({
  address, network: "mainnet", reader, explorer: null, dex, knownLockers: [], explorerBase: "https://explorer.arc.io", extraPools,
});
const v4Only: DexConfig = { quoteTokens: DEX.mainnet!.quoteTokens, v4: UNISWAP_V4 };
const aeroOnly: DexConfig = { quoteTokens: DEX.mainnet!.quoteTokens, aero: AERODROME };
const lower = (a: string) => a.toLowerCase();

describe("Arc mainnet, read-only", () => {
  it("has code at every address the pool checks rely on, and the contracts point at each other", async () => {
    const named = {
      PoolManager: UNISWAP_V4.poolManager,
      "v4 PositionManager": UNISWAP_V4.positionManager,
      StateView: UNISWAP_V4.stateView,
      V4Quoter: UNISWAP_V4.quoter,
      "Aerodrome CL factory": AERODROME.clFactory,
      "Aerodrome position manager": AERODROME.positionManager,
      Multicall3: MULTICALL3,
    };
    for (const [name, address] of Object.entries(named)) expect(await reader.getCode(address), name).not.toBeNull();

    const poolManagerOf = parseAbi(["function poolManager() view returns (address)"]);
    for (const address of [UNISWAP_V4.positionManager, UNISWAP_V4.stateView, UNISWAP_V4.quoter]) {
      expect(lower((await reader.read(address, poolManagerOf, "poolManager")) as string), address).toBe(lower(UNISWAP_V4.poolManager));
    }
    const factoryOf = parseAbi(["function factory() view returns (address)"]);
    expect(lower((await reader.read(AERODROME.positionManager, factoryOf, "factory")) as string)).toBe(lower(AERODROME.clFactory));
  });

  it("lists the tick spacings the config lists, and no others: Aerodrome's factory says which are enabled", async () => {
    const enabled = (await reader.read(AERODROME.clFactory, parseAbi(["function tickSpacings() view returns (int24[])"]), "tickSpacings")) as readonly number[];
    expect([...enabled].sort((a, b) => a - b)).toEqual(AERODROME.tickSpacings);
  });

  it("finds the USDC/EURC pool with the standard v4 probe, and the quoter pays 1,000 USDC out of it", async () => {
    const scan = await findPools(input(EURC.mainnet, v4Only));
    const pool = scan.pools.find((p) => p.poolId === USDC_EURC_POOL);
    expect(pool, `pool ${USDC_EURC_POOL} in ${JSON.stringify(scan.pools.map((p) => p.poolId))}`).toBeDefined();
    expect(pool).toMatchObject({ version: "v4", quote: "USDC", liquid: true, address: UNISWAP_V4.poolManager });
    expect(pool!.depth).toBeGreaterThan(0n);
    expect(pool!.key).toEqual(v4PoolKey(USDC, EURC.mainnet, 500, 10));
    expect(v4PoolId(pool!.key!)).toBe(USDC_EURC_POOL);
    expect(scan.silent).toEqual([]);
  });

  it("agrees with the V4Quoter about what is in range: exactly that much out costs what the liquidity says", async () => {
    // Every read at one block, so the price can't move between them. Two blocks back: the RPC sits behind a load balancer whose
    // nodes can be a block apart.
    const blockNumber = (await paced(() => client.getBlockNumber())) - 2n;
    const stateView = (functionName: "getSlot0" | "getLiquidity") =>
      paced(() => client.readContract({ address: UNISWAP_V4.stateView, abi: stateViewAbi, functionName, args: [USDC_EURC_POOL], blockNumber }));
    const [sqrtPriceX96, tick, , lpFee] = (await stateView("getSlot0")) as readonly [bigint, number, number, number];
    const liquidity = (await stateView("getLiquidity")) as bigint;
    const key = v4PoolKey(USDC, EURC.mainnet, 500, 10);

    // USDC is currency0 here, so the quote currency comes out as currency0 and EURC goes in.
    const inRange = quoteInRange({ sqrtPriceX96, tick, tickSpacing: 10, liquidity, quoteIsCurrency0: true });
    expect(inRange).toBeGreaterThan(0n);
    const upper = sqrtRatioAtTick(Math.floor(tick / 10) * 10 + 10);
    const moved = (liquidity * (upper - sqrtPriceX96)) / (1n << 96n); // the EURC that moves the price up to the range's edge
    const expectedIn = (moved * 1_000_000n) / BigInt(1_000_000 - lpFee);

    const [amountIn] = (await paced(() =>
      client.readContract({
        address: UNISWAP_V4.quoter,
        abi: quoterAbi,
        functionName: "quoteExactOutputSingle",
        args: [{ poolKey: key, zeroForOne: false, exactAmount: inRange, hookData: "0x" }],
        blockNumber,
      } as never),
    )) as readonly [bigint, bigint];
    const off = amountIn > expectedIn ? amountIn - expectedIn : expectedIn - amountIn;
    expect(Number(off) / Number(expectedIn), `quoted ${amountIn}, expected ${expectedIn} at block ${blockNumber}`).toBeLessThan(1e-6);
  });

  it("finds a native-USDC pool with the standard probe, whatever its liquidity is by now", async () => {
    const scan = await findPools(input(NATIVE_POOL.token, v4Only));
    const pool = scan.pools.find((p) => p.poolId === NATIVE_POOL.id);
    expect(pool, `pool ${NATIVE_POOL.id}`).toBeDefined();
    expect(pool).toMatchObject({ version: "v4", quote: "USDC" });
    expect(pool!.key!.currency0).toBe(NATIVE);
    expect(typeof pool!.depth).toBe("bigint");
    expect(typeof pool!.liquid).toBe("boolean");
  });

  it("finds a hooked v4 pool only when the index supplies it", async () => {
    const token = HOOKED_POOL.key.currency1;
    const without = await findPools(input(token, v4Only));
    expect(without.pools.map((p) => p.poolId)).not.toContain(HOOKED_POOL.id);

    const given = await findPools(input(token, v4Only, [{ version: "v4", key: HOOKED_POOL.key }]));
    const pool = given.pools.find((p) => p.poolId === HOOKED_POOL.id);
    expect(pool, `pool ${HOOKED_POOL.id}`).toMatchObject({ version: "v4", quote: "USDC", key: HOOKED_POOL.key });
    expect(typeof pool!.liquid).toBe("boolean");
  });

  it("finds the WETH/USDC Aerodrome pool and reads its USDC balance", async () => {
    const scan = await findPools(input(WETH, aeroOnly));
    const pool = scan.pools.find((p) => lower(p.address) === lower(AERO_WETH_POOL));
    expect(pool, `pool ${AERO_WETH_POOL}`).toMatchObject({ version: "aero", quote: "USDC", liquid: true });
    expect(pool!.depth).toBeGreaterThanOrEqual(1_000_000_000n);
    expect(scan.silent).toEqual([]);
  });

  it("says a token with no pools has none, after every family answered", async () => {
    const scan: PoolScan = await findPools(input("0x000000000000000000000000000000000000dEaD", DEX.mainnet));
    expect(scan).toEqual({ pools: [], factoriesAnswered: true, silent: [] });
  });

  it("inspects WETH end to end: liquidity passes on a pool it names, and the report is JSON-safe", async () => {
    const report = await inspect(input(WETH, DEX.mainnet));
    const liquidity = report.findings.find((f) => f.id === "liquidity")!;
    expect(liquidity.status).toBe("pass");
    expect(liquidity.title).toMatch(/^(1,000 USDC can be swapped out of Uniswap v4|[\d,]+ (USDC|EURC) of liquidity on (Uniswap v[23]|Aerodrome))$/);
    expect(JSON.parse(JSON.stringify(report)).address).toBe(report.address);
  });

  it("inspects a token with only v4 pools end to end: lp-lock stays unknown and says why, with no fix to offer", async () => {
    const report = await inspect(input(NATIVE_POOL.token, DEX.mainnet));
    const lpLock = report.findings.find((f) => f.id === "lp-lock")!;
    expect(lpLock).toMatchObject({ status: "unknown", fixAppId: null });
    expect(lpLock.detail).toMatch(/^Only Uniswap v4 pools were found, and liquidity positions in them can't be read without an index yet\.$/);
  });
});
