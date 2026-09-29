import { describe, expect, it } from "vitest";
import { EURC, USDC } from "@arcos/chain";
import type { PoolKey } from "../types";
import { NATIVE, STANDARD_V4_TIERS, quoteInRange, sqrtRatioAtTick, standardV4Keys, v4PoolId, v4PoolKey } from "../v4";

const Q96 = 1n << 96n;

/**
 * Pools from PoolManager `Initialize` logs on Arc mainnet: the block, the pool id as the contract emitted it (topic 1), and
 * the key it was emitted for. Recomputed on 2026-09-29 for 222 logs from the last 10,000 blocks: no mismatch.
 */
const KNOWN: { label: string; block: number; id: string; key: PoolKey }[] = [
  { label: "native / token, 0.25%", block: 23410877, id: "0xa930234d875e21c35f1da88ed4a2ff27ea78091fcadb5708f68c355b61010b4a", key: { currency0: NATIVE, currency1: "0x5101f7e21278290f0eabEa8cAfFbDF301646e9cf", fee: 2500, tickSpacing: 50, hooks: NATIVE } },
  { label: "USDC / token, 0.3%", block: 23398734, id: "0x35bb405df679f9f86ee3fe0824e2615ca5c443f3c9a61b33dc9274ab22aeb1f9", key: { currency0: USDC, currency1: "0x960C67B8526E6328b30Ed2c2fAeA0355BEB62A83", fee: 3000, tickSpacing: 60, hooks: NATIVE } },
  { label: "token / USDC, 1%", block: 23401477, id: "0x02d8afd013d60a6e0065a2eba3946b0a6dad3e8ccd3cd8c71f3fe1a9518c8b8f", key: { currency0: "0x2bAb1801ae806e4cc81B1b977f7B3463F0c2Ea48", currency1: USDC, fee: 10000, tickSpacing: 200, hooks: NATIVE } },
  { label: "USDC / token, 0.01%", block: 23408225, id: "0x3fdc941e3193df590baaaf2d95dece32f68a8a1cfac3684eef67cfe93174c2ab", key: { currency0: USDC, currency1: "0xf4E0F68881e67714b594b891578Bd20c86377c3f", fee: 100, tickSpacing: 1, hooks: NATIVE } },
  { label: "USDC / token with a hook, 1%", block: 23410676, id: "0x1f1f87b6d58383d7d25b7b6bb2af557ca8f85545379f00cf8741ea3363838019", key: { currency0: USDC, currency1: "0xb6C3cC01Ad7D6f786E791E317d47aa62A75487Aa", fee: 10000, tickSpacing: 200, hooks: "0x94f8be2402C0e2eb65F3218a7282A5301371E044" } },
  { label: "USDC / token, dynamic fee, hooked", block: 23385756, id: "0xbb37776845b8b2a28155cfd57cfd0bc49d5b518775cc2ee1aaeb76aef99bf832", key: { currency0: USDC, currency1: "0xDBa7621AaEa99E3C931c32D77b7B5bFd4b3f6010", fee: 8388608, tickSpacing: 200, hooks: "0xD9D3d09d39F3a8185250FF5568694B643bCF20Cc" } },
];

describe("v4PoolId", () => {
  it.each(KNOWN)("hashes $label to the id the PoolManager emitted (block $block)", ({ id, key }) => {
    expect(v4PoolId(key)).toBe(id);
  });
});

describe("v4PoolKey", () => {
  it.each(KNOWN)("sorts $label whichever way round the pair is given", ({ key }) => {
    const { currency0, currency1, fee, tickSpacing, hooks } = key;
    expect(v4PoolKey(currency0, currency1, fee, tickSpacing, hooks)).toEqual(key);
    expect(v4PoolKey(currency1, currency0, fee, tickSpacing, hooks)).toEqual(key);
  });

  it("puts the native currency first, and leaves out hooks unless told", () => {
    const k = v4PoolKey("0x1111111111111111111111111111111111111111", NATIVE, 3000, 60);
    expect(k.currency0).toBe(NATIVE);
    expect(k.hooks).toBe(NATIVE);
  });

  it("checksums what it is given", () => {
    expect(v4PoolKey(USDC, EURC.mainnet.toLowerCase() as `0x${string}`, 500, 10).currency1).toBe(EURC.mainnet);
  });
});

describe("standardV4Keys", () => {
  const TOKEN = "0x1111111111111111111111111111111111111111";

  it("probes the five standard hookless tiers against each quote currency: 15 distinct pools for three", () => {
    expect(STANDARD_V4_TIERS.map((t) => [t.fee, t.tickSpacing])).toEqual([[100, 1], [500, 10], [2500, 50], [3000, 60], [10000, 200]]);
    const keys = standardV4Keys(TOKEN, [NATIVE, USDC, EURC.mainnet]);
    expect(keys).toHaveLength(15);
    expect(new Set(keys.map(v4PoolId)).size).toBe(15);
    for (const k of keys) {
      expect(k.hooks).toBe(NATIVE);
      expect(BigInt(k.currency0) < BigInt(k.currency1)).toBe(true);
      expect([k.currency0, k.currency1]).toContain(TOKEN);
    }
  });
});

describe("sqrtRatioAtTick", () => {
  it("is 2^96 at tick 0 and reaches the exact values at the limits", () => {
    expect(sqrtRatioAtTick(0)).toBe(Q96);
    // The exact values, from a 120-digit decimal computation. Uniswap publishes MIN_SQRT_RATIO 4295128739, which rounds the
    // first one up, and MAX_SQRT_RATIO 1461446703485210103287273052203988822378723970342, which comes from rounded
    // constants and is 3e-20 higher.
    expect(sqrtRatioAtTick(-887272)).toBe(4295128738n);
    expect(sqrtRatioAtTick(887272)).toBe(1461446703485210103244672773810124308346321380902n);
  });

  it("is the reciprocal at the opposite tick, to rounding", () => {
    for (const t of [1, 10, 1251, 67270, 400000]) {
      const product = sqrtRatioAtTick(t) * sqrtRatioAtTick(-t);
      const off = product > Q96 * Q96 ? product - Q96 * Q96 : Q96 * Q96 - product;
      expect(Number(off) / Number(Q96 * Q96)).toBeLessThan(1e-15);
    }
  });

  // Live slot0 values, Arc mainnet, 2026-09-29 (v4 USDC/EURC and Aerodrome pools: the same tick math): the price sits inside
  // its own tick.
  it.each([
    [-1251, 74424664170632289860573093359n],
    [-1253, 74417585193978433990071955416n],
    [-2795, 68896926887959258862882808439n],
    [67270, 2288607730176563629820617796636n],
    [-197361, 4106347325441410454932906n],
    [371650, 9306164581915843955019155633362151753n],
    [-371354, 684605544136263886709n],
  ])("brackets a live pool at tick %i: sqrt(tick) <= sqrtPriceX96 < sqrt(tick + 1)", (tick, sqrtPriceX96) => {
    expect(sqrtRatioAtTick(tick) <= sqrtPriceX96 && sqrtPriceX96 < sqrtRatioAtTick(tick + 1)).toBe(true);
  });
});

describe("quoteInRange", () => {
  // The USDC/EURC 0.05% pool (tick spacing 10), Arc mainnet block 23,412,422. USDC is currency0. For exactly 281.248329 USDC out
  // the V4Quoter asked 248,314,687 EURC-raw (block 23,411,937, same tick and liquidity), and L * (sqrt(upper) - P) / 2^96
  // / (1 - fee) is 248,314,685: the figure agrees with the contract's own swap math to 8e-9.
  const usdcEurc = { sqrtPriceX96: 74424664170632289860573093359n, tick: -1251, tickSpacing: 10, liquidity: 5555951229628n };

  it("counts the currency0 the active liquidity holds up to the range's upper edge", () => {
    expect(quoteInRange({ ...usdcEurc, quoteIsCurrency0: true })).toBe(281248329n);
  });

  it("counts the currency1 it holds down to the range's lower edge", () => {
    expect(quoteInRange({ ...usdcEurc, quoteIsCurrency0: false })).toBe(2360701487n);
  });

  it("is 0 with no active liquidity", () => {
    expect(quoteInRange({ ...usdcEurc, liquidity: 0n, quoteIsCurrency0: true })).toBe(0n);
    expect(quoteInRange({ ...usdcEurc, liquidity: 0n, quoteIsCurrency0: false })).toBe(0n);
  });

  it("finds no currency1 to pay out when the price sits on the lower edge (a single-sided pool), and all the currency0", () => {
    const edge = { sqrtPriceX96: sqrtRatioAtTick(-1260), tick: -1260, tickSpacing: 10, liquidity: 10n ** 12n };
    expect(quoteInRange({ ...edge, quoteIsCurrency0: false })).toBe(0n);
    expect(quoteInRange({ ...edge, quoteIsCurrency0: true })).toBe(532352026n);
  });

  it("floors a negative tick to the range below it: tick -1 with spacing 10 is the range [-10, 0]", () => {
    const p = { sqrtPriceX96: sqrtRatioAtTick(-1), tick: -1, tickSpacing: 10, liquidity: 10n ** 12n };
    expect(quoteInRange({ ...p, quoteIsCurrency0: false })).toBe(449853784n);
    expect(quoteInRange({ ...p, quoteIsCurrency0: true })).toBe(49998750n);
  });

  it("reads the range of the tick's own spacing: spacing 60 at tick 0 is [0, 60]", () => {
    const p = { sqrtPriceX96: Q96, tick: 0, tickSpacing: 60, liquidity: 10n ** 12n };
    expect(quoteInRange({ ...p, quoteIsCurrency0: true })).toBe(2995354955n);
    expect(quoteInRange({ ...p, quoteIsCurrency0: false })).toBe(0n);
  });
});
