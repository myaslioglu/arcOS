import { describe, expect, it } from "vitest";
import { feeFactor, findPath, v2Ask, v4Ask, type Ask, type HolderClass } from "../lp-path";
import { tokenSqrtPrice } from "../v4-positions";
import { sqrtRatioAtTick } from "../v4";

// A straight-line ask on a toy axis: `rate` of quote per unit of square-root price, between `lo` and `hi`.
const ask = (owner: HolderClass, lo: bigint, hi: bigint | null, rate: bigint, tokens = 0n): Ask => ({
  owner,
  lo,
  hi,
  slope: rate << 128n,
  tokensAbove: (price) => (hi === null || price < hi ? tokens : 0n),
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
    const inside = ask("burned", E, (E * 12n) / 10n, 10_000n, 700n);
    const far = ask("withdrawable", 5n * E, 6n * E, 1n, 900n);
    const path = findPath([inside, far], 1_000n)!;
    expect(path.windowTokens).toBe(700n);
    expect(path.beyond).toMatchObject({ withdrawable: 900n, burned: 0n });
  });
});

describe("v4Ask", () => {
  const base = { owner: "burned" as const, quoteDecimals: 6, feePips: 0, scale: 1n, liquidity: 10n ** 18n };

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

describe("the LP fee", () => {
  const base = { owner: "burned" as const, quoteDecimals: 6, scale: 1n, liquidity: 10n ** 18n, quoteIsCurrency0: false, sqrtPriceX96: sqrtRatioAtTick(0), tickLower: 60, tickUpper: 600 };
  const near = (a: bigint, b: bigint) => (a > b ? a - b : b - a) * 1_000_000n <= b;

  it("is a factor on the square root of what a buyer pays: 1 / sqrt(1 - fee)", () => {
    expect(feeFactor(0)).toBe(10n ** 18n);
    // A 75% fee: the buyer pays four times the pool's price, twice its square root.
    expect(feeFactor(750_000)).toBe(2n * 10n ** 18n);
    expect(near(feeFactor(3_000), 1_001_503_383_459_640_000n)).toBe(true);
    // 100% and nonsense are read as one pip short of it, never a division by zero.
    expect(feeFactor(1_000_000)).toBe(feeFactor(999_999));
    expect(feeFactor(5_000_000)).toBe(10n ** 21n);
  });

  it("moves a pool's asks up the path by its fee, and leaves what they take and what they hold as they are", () => {
    const free = v4Ask({ ...base, feePips: 0 })!;
    const dear = v4Ask({ ...base, feePips: 990_000 })!;
    // A 99% fee: a buyer pays a hundred times the pool's price, ten times its square root.
    expect(near(dear.lo, free.lo * 10n)).toBe(true);
    expect(near(dear.hi!, free.hi! * 10n)).toBe(true);
    // The same quote goes into the position over the range, so a tenth of it per unit of the (ten times longer) way.
    expect(near(dear.slope * 10n, free.slope)).toBe(true);
    expect(dear.tokensAbove(dear.lo)).toBe(free.tokensAbove(free.lo));
    const mid = (free.lo + free.hi!) / 2n;
    expect(near(dear.tokensAbove(mid * 10n), free.tokensAbove(mid))).toBe(true);
  });

  it("puts a cheap-looking wall in a 99%-fee pool behind an ask at the market", () => {
    // The wall's pool price is 60% of the market's; what a buyer pays there is sixty times the market.
    const wall = v4Ask({ ...base, owner: "burned", feePips: 990_000, sqrtPriceX96: sqrtRatioAtTick(-5_100), tickLower: -5_100, tickUpper: 1_800, liquidity: 10n ** 24n })!;
    const market = v4Ask({ ...base, owner: "withdrawable", feePips: 3_000, tickLower: 0, tickUpper: 1_800, liquidity: 10n ** 22n })!;
    expect(wall.lo > market.hi!).toBe(true);
    const path = findPath([wall, market], 1_000n)!;
    expect(path.prefixes[0]).toMatchObject({ burned: 0n });
    expect(path.prefixes[0]!.withdrawable).toBeGreaterThanOrEqual(1_000n);
  });
});

describe("v2Ask", () => {
  it("is null without tokens, quote or a price", () => {
    expect(v2Ask({ owner: "burned", price: 0n, reserve: 1n, tokens: 1n })).toBeNull();
    expect(v2Ask({ owner: "burned", price: 1n, reserve: 0n, tokens: 1n })).toBeNull();
    expect(v2Ask({ owner: "burned", price: 1n, reserve: 1n, tokens: 0n })).toBeNull();
  });

  it("starts at what a buyer pays, 0.3% over the pair's price, takes its reserve again each time the square root of that doubles, and holds half the tokens then", () => {
    const a = v2Ask({ owner: "locked", price: E, reserve: 600n * E, tokens: 1_000n })!;
    const lo = (E * feeFactor(3_000)) / 10n ** 18n;
    expect(a).toMatchObject({ lo, hi: null });
    const path = findPath([a], 600n * E)!;
    expect(path.p1! - 2n * lo >= 0n && path.p1! - 2n * lo <= 2n).toBe(true);
    expect(a.tokensAbove(2n * lo)).toBe(500n);
    expect(a.tokensAbove(E / 2n)).toBe(1_000n);
  });
});
