import { describe, expect, it } from "vitest";
import { findPath, v2Ask, v4Ask, type Ask, type HolderClass } from "../lp-path";
import { tokenSqrtPrice } from "../v4-positions";
import { sqrtRatioAtTick } from "../v4";

// A straight-line ask on a toy axis: `rate` of quote per unit of square-root price, between `lo` and `hi`.
const ask = (owner: HolderClass, lo: bigint, hi: bigint | null, rate: bigint, anchor = true, tokens = 0n): Ask => ({
  owner,
  lo,
  hi,
  slope: rate << 128n,
  tokensAbove: (price) => (hi === null || price < hi ? tokens : 0n),
  anchor,
});
const E = 10n ** 18n;
const SQRT2 = 1_414_213_562_373_095_048n;

describe("findPath", () => {
  it("is null with nothing for sale", () => {
    expect(findPath([], 1_000n)).toBeNull();
  });

  it("finds the price at which the depth has been paid, and ends the window at twice that price", () => {
    // 10 of quote per unit from 1: 1,000 has been paid 100 units up.
    const path = findPath([ask("burned", E, 10n * E, 10n)], 1_000n)!;
    expect(path.reached).toBe(true);
    expect(path.p1).toBe(E + 100n);
    const end = ((E + 100n) * SQRT2) / E;
    expect(path.windowEnd! - end >= 0n && path.windowEnd! - end <= 1n).toBe(true);
    // Two points: P1 and the window's end. All of it burned.
    expect(path.prefixes).toHaveLength(2);
    expect(path.prefixes[0]!.burned).toBe(1_000n);
    expect(path.prefixes[1]!.burned).toBe(10n * (path.windowEnd! - E));
  });

  it("starts at the cheapest ask and checks every edge inside the window: the first in line is seen alone", () => {
    // A wallet sells first, from 1.0 to 1.1; burned liquidity takes over from 1.1.
    const wallet = ask("withdrawable", E, (E * 11n) / 10n, 1n);
    const burned = ask("burned", (E * 11n) / 10n, 3n * E, 100n);
    const path = findPath([burned, wallet], E / 20n)!;
    // 0.05 of quote is paid at 1.05, inside the wallet's range: the first prefix is the wallet's alone.
    expect(path.p1).toBe((E * 105n) / 100n);
    expect(path.prefixes[0]).toMatchObject({ withdrawable: E / 20n, burned: 0n });
    // Then its upper edge, where the burned range begins, then the window's end.
    expect(path.prefixes).toHaveLength(3);
    expect(path.prefixes[1]).toMatchObject({ withdrawable: E / 10n, burned: 0n });
    expect(path.prefixes[2]!.withdrawable).toBe(E / 10n);
    expect(path.prefixes[2]!.burned).toBe(100n * (path.windowEnd! - (E * 11n) / 10n));
  });

  it("takes the start and the window from the anchors, and the shares from every ask inside", () => {
    // A cheap ask in a pool where a hook can refuse the swap, and the real one at 1.
    const decoy = ask("swapHook", E / 100n, E / 50n, 1_000_000n, false);
    const real = ask("withdrawable", E, 2n * E, 10n);
    const beside = ask("swapHook", E, 2n * E, 30n, false);
    const path = findPath([decoy, real, beside], 1_000n)!;
    expect(path.p1).toBe(E + 100n);
    // The decoy lies below the start: nothing of it is counted. The hooked ask beside the real one is.
    expect(path.prefixes[0]).toMatchObject({ withdrawable: 1_000n, swapHook: 3_000n });
    // With no anchor at all, every ask anchors.
    const alone = findPath([decoy], 1_000n)!;
    expect(alone.p1! < E / 50n).toBe(true);
    expect(alone.prefixes[0]!.swapHook).toBeGreaterThanOrEqual(1_000n);
  });

  it("counts what is sold below the start in a pool that doesn't anchor, unless it is burned behind a swap hook", () => {
    const real = ask("burned", 4n * E, 8n * E, 10n);
    // A wallet's range in a hooked pool, wholly below the anchors' start: 2 * E of quote before anyone reaches the path.
    const below = ask("withdrawable", E, 2n * E, 2n, false);
    const path = findPath([real, below], 1_000n)!;
    expect(path.p1).toBe(4n * E + 100n);
    expect(path.prefixes[0]).toMatchObject({ burned: 1_000n, withdrawable: 2n * E });
    // Burned there instead: it may be tokens nobody can buy, and it is left out below the start.
    const wall = findPath([real, ask("swapHook", E, 2n * E, 2n, false)], 1_000n)!;
    expect(wall.prefixes[0]).toMatchObject({ burned: 1_000n, swapHook: 0n });
    // But not unseen: the strict reading, which a pass is held to, counts it.
    expect(wall.strict[0]).toMatchObject({ burned: 1_000n, swapHook: 2n * E });
    expect(path.strict).toEqual(path.prefixes);
  });

  it("walks an endless ask up in doublings until the depth is reached", () => {
    const path = findPath([ask("burned", E, null, 1n)], 5n * E)!;
    expect(path.reached).toBe(true);
    expect(path.p1).toBe(6n * E);
    expect(path.prefixes[0]!.burned).toBe(5n * E);
  });

  it("gives the whole path as one prefix when the depth is never reached, and no window", () => {
    const path = findPath([ask("withdrawable", E, 2n * E, 1n), ask("burned", 3n * E, 4n * E, 2n)], 100n * E)!;
    expect(path).toMatchObject({ reached: false, p1: null, windowEnd: null, windowTokens: 0n });
    expect(path.prefixes).toHaveLength(1);
    expect(path.prefixes[0]).toMatchObject({ withdrawable: E, burned: 2n * E });
  });

  it("counts the tokens the window sells and those still for sale beyond it, by owner", () => {
    const inside = ask("burned", E, (E * 12n) / 10n, 10_000n, true, 700n);
    const far = ask("withdrawable", 5n * E, 6n * E, 1n, true, 900n);
    const path = findPath([inside, far], 1_000n)!;
    expect(path.windowTokens).toBe(700n);
    expect(path.beyond).toMatchObject({ withdrawable: 900n, burned: 0n });
  });
});

describe("v4Ask", () => {
  const base = { owner: "burned" as const, quoteDecimals: 6, anchor: true, scale: 1n, liquidity: 10n ** 18n };

  it("is null for a range wholly below the price: it sells nothing", () => {
    // The token is currency0 (the quote is currency1): below the price a range holds the quote only.
    expect(v4Ask({ ...base, quoteIsCurrency0: false, sqrtPriceX96: sqrtRatioAtTick(0), tickLower: -600, tickUpper: -60 })).toBeNull();
    expect(v4Ask({ ...base, quoteIsCurrency0: false, sqrtPriceX96: sqrtRatioAtTick(0), tickLower: -600, tickUpper: -60, liquidity: 0n })).toBeNull();
  });

  it("starts at the pool's price inside the range and at the lower edge above it, and holds no tokens past its top", () => {
    const at = sqrtRatioAtTick(0);
    const inRange = v4Ask({ ...base, quoteIsCurrency0: false, sqrtPriceX96: at, tickLower: -600, tickUpper: 600 })!;
    expect(inRange.lo).toBe(tokenSqrtPrice(at, false, 6));
    expect(inRange.hi).toBe(tokenSqrtPrice(sqrtRatioAtTick(600), false, 6));
    const above = v4Ask({ ...base, quoteIsCurrency0: false, sqrtPriceX96: at, tickLower: 60, tickUpper: 600 })!;
    expect(above.lo).toBe(tokenSqrtPrice(sqrtRatioAtTick(60), false, 6));
    expect(above.tokensAbove(above.lo)).toBeGreaterThan(0n);
    expect(above.tokensAbove(above.hi!)).toBe(0n);
    // Halfway up it has sold part of them.
    const mid = (above.lo + above.hi!) / 2n;
    expect(above.tokensAbove(mid)).toBeLessThan(above.tokensAbove(above.lo));
    expect(above.tokensAbove(mid)).toBeGreaterThan(0n);
  });

  it("reads the mirrored pool the same: the token as currency1 sells where the raw price falls", () => {
    const at = sqrtRatioAtTick(0);
    const straight = v4Ask({ ...base, quoteIsCurrency0: false, sqrtPriceX96: at, tickLower: 60, tickUpper: 600 })!;
    const mirrored = v4Ask({ ...base, quoteIsCurrency0: true, sqrtPriceX96: at, tickLower: -600, tickUpper: -60 })!;
    expect(mirrored.hi! > mirrored.lo).toBe(true);
    const near = (a: bigint, b: bigint) => (a > b ? a - b : b - a) * 1_000_000n <= b;
    expect(near(mirrored.slope, straight.slope)).toBe(true);
    expect(near(mirrored.tokensAbove(mirrored.lo), straight.tokensAbove(straight.lo))).toBe(true);
    expect(v4Ask({ ...base, quoteIsCurrency0: true, sqrtPriceX96: at, tickLower: 60, tickUpper: 600 })).toBeNull();
  });
});

describe("v2Ask", () => {
  it("is null without tokens, quote or a price", () => {
    expect(v2Ask({ owner: "burned", price: 0n, reserve: 1n, tokens: 1n })).toBeNull();
    expect(v2Ask({ owner: "burned", price: 1n, reserve: 0n, tokens: 1n })).toBeNull();
    expect(v2Ask({ owner: "burned", price: 1n, reserve: 1n, tokens: 0n })).toBeNull();
  });

  it("takes its reserve again each time the square root of the price doubles, and holds half the tokens then", () => {
    const a = v2Ask({ owner: "locked", price: E, reserve: 600n * E, tokens: 1_000n })!;
    expect(a).toMatchObject({ lo: E, hi: null, anchor: true });
    const path = findPath([a], 600n * E)!;
    expect(path.p1).toBe(2n * E);
    expect(a.tokensAbove(2n * E)).toBe(500n);
    expect(a.tokensAbove(E / 2n)).toBe(1_000n);
  });
});
