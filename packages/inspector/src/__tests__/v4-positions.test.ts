import { encodeAbiParameters } from "viem";
import { describe, expect, it } from "vitest";
import { UNISWAP_V4, USDC } from "@arcos/chain";
import { sqrtRatioAtTick, v4PoolId, v4PoolKey } from "../v4";
import {
  HEAD_MARGIN,
  MAX_HOLDER_CODE_READS,
  MAX_POSITIONS,
  INITIALIZE_TOPIC,
  MAX_POSITIONS_PER_POOL,
  MODIFY_LIQUIDITY_TOPIC,
  TAIL_MAX_BLOCKS,
  amountsForLiquidity,
  beforeDeadline,
  CODE_READER,
  decodeCodeReader,
  classifyHolder,
  hookCanChangeRemoval,
  isPositionKey,
  positionFromLog,
  positionQuote,
  ReadsTimedOut,
  doubledPrice,
  rawSqrtPriceAt,
  tokenSqrtPrice,
  v2TokenSqrtPrice,
  readHolderCode,
  readV4Positions,
  type V4PoolRef,
} from "../v4-positions";
import type { ChainLog, V4PositionIndex, V4PositionKey } from "../types";
import { fakeChain, type FakePosition } from "./fixtures/chain-fake";

const Q96 = 1n << 96n;
/** Integer square root, for the reference prices below. */
function isqrt(n: bigint): bigint {
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}
/** Uniswap's test helper `encodePriceSqrt(reserve1, reserve0)`: sqrt(reserve1 / reserve0) as a Q64.96. */
const encodePriceSqrt = (reserve1: bigint, reserve0: bigint): bigint => isqrt((reserve1 << 192n) / reserve0);

describe("amountsForLiquidity: Uniswap's LiquidityAmounts.getAmountsForLiquidity", () => {
  // The cases and the expected amounts of v3-periphery's test/LiquidityAmounts.spec.ts ("getAmountsForLiquidity"): a
  // range from price 100/110 to 110/100.
  const a = encodePriceSqrt(100n, 110n);
  const b = encodePriceSqrt(110n, 100n);

  it("splits liquidity into both currencies when the price is inside the range", () => {
    expect(amountsForLiquidity(encodePriceSqrt(1n, 1n), a, b, 2148n)).toEqual({ amount0: 99n, amount1: 99n });
  });

  it("is all currency0 when the price is below the range", () => {
    expect(amountsForLiquidity(encodePriceSqrt(99n, 110n), a, b, 1048n)).toEqual({ amount0: 99n, amount1: 0n });
  });

  it("is all currency1 when the price is above the range", () => {
    expect(amountsForLiquidity(encodePriceSqrt(111n, 100n), a, b, 2097n)).toEqual({ amount0: 0n, amount1: 199n });
  });

  it("treats a price exactly on the lower edge as below, and one on the upper edge as above", () => {
    expect(amountsForLiquidity(a, a, b, 1048n)).toEqual({ amount0: 99n, amount1: 0n });
    expect(amountsForLiquidity(b, a, b, 2097n)).toEqual({ amount0: 0n, amount1: 199n });
  });

  it("takes the range's two prices in either order, and holds nothing with no liquidity", () => {
    expect(amountsForLiquidity(encodePriceSqrt(1n, 1n), b, a, 2148n)).toEqual({ amount0: 99n, amount1: 99n });
    expect(amountsForLiquidity(encodePriceSqrt(1n, 1n), a, b, 0n)).toEqual({ amount0: 0n, amount1: 0n });
  });

  it("gives x = y = L for a full-range position at price 1, less what the range's ends cut off", () => {
    const L = 10n ** 18n;
    const { amount0, amount1 } = amountsForLiquidity(Q96, sqrtRatioAtTick(-887_220), sqrtRatioAtTick(887_220), L);
    // The ends are at sqrt price 2^-64 and 2^64 or so: each side is L * (1 - about 5.4e-20), cut down to the unit.
    for (const amount of [amount0, amount1]) {
      expect(amount).toBeLessThanOrEqual(L);
      expect(L - amount).toBeLessThan(10n);
    }
  });

  it("never rounds up: the two amounts, put back at the same price, give no more than the liquidity", () => {
    const [lower, upper, price] = [sqrtRatioAtTick(-1200), sqrtRatioAtTick(4000), sqrtRatioAtTick(137)];
    const L = 123_456_789_012_345_678n;
    const { amount0, amount1 } = amountsForLiquidity(price, lower, upper, L);
    // Uniswap's getLiquidityForAmount0 and getLiquidityForAmount1, exact: the liquidity each amount alone could back.
    const from0 = (amount0 * ((price * upper) / Q96)) / (upper - price);
    const from1 = (amount1 * Q96) / (price - lower);
    expect(from0).toBeLessThanOrEqual(L);
    expect(from1).toBeLessThanOrEqual(L);
    expect(L - from0).toBeLessThan(L / 10n ** 12n);
    expect(L - from1).toBeLessThan(L / 10n ** 12n);
  });
});

describe("positionQuote: a position in the quote currency alone", () => {
  it("reach: what sellers take out by selling the token down to half its price, either way up", () => {
    const L18 = 10n ** 18n;
    // The token as currency0: half the price is about 6,932 ticks down. A range wholly below that holds quote out of reach.
    const far = positionQuote({ sqrtPriceX96: Q96, tickLower: -20_000, tickUpper: -8_000, liquidity: L18, quoteIsCurrency0: false });
    expect(far.now).toBeGreaterThan(0n);
    expect(far.reach).toBe(0n);
    // A range just under the price is all within reach, and one from the price far down in part.
    const near = positionQuote({ sqrtPriceX96: Q96, tickLower: -3_000, tickUpper: -60, liquidity: L18, quoteIsCurrency0: false });
    expect(near.reach).toBe(near.now);
    const long = positionQuote({ sqrtPriceX96: Q96, tickLower: -40_000, tickUpper: 0, liquidity: L18, quoteIsCurrency0: false });
    expect(long.reach > 0n && long.reach < long.now).toBe(true);
    // Mirrored: the token as currency1, its price falling as the raw price rises.
    const mirrored = positionQuote({ sqrtPriceX96: Q96, tickLower: 60, tickUpper: 3_000, liquidity: L18, quoteIsCurrency0: true });
    expect(mirrored.reach).toBe(mirrored.now);
    expect(mirrored.reach).toBe(near.reach);
    expect(positionQuote({ sqrtPriceX96: Q96, tickLower: 8_000, tickUpper: 20_000, liquidity: L18, quoteIsCurrency0: true }).reach).toBe(0n);
  });

  const L = 10n ** 18n;
  const range = { tickLower: -600, tickUpper: 600 };
  const [lower, upper] = [sqrtRatioAtTick(-600), sqrtRatioAtTick(600)];
  // Square roots of a price doubled and halved, as the function takes them.
  const SQRT2 = 1_414_213_562_373_095_048_801_688_724_209n;
  const up = (sqrtP: bigint) => (sqrtP * SQRT2) / 10n ** 30n;
  const down = (sqrtP: bigint) => (sqrtP * 10n ** 30n) / SQRT2;

  it("holds now the quote side of LiquidityAmounts, whichever currency the quote is, and never the token side", () => {
    const { amount0, amount1 } = amountsForLiquidity(Q96, lower, upper, L);
    expect(amount0).toBeGreaterThan(0n);
    expect(positionQuote({ sqrtPriceX96: Q96, ...range, liquidity: L, quoteIsCurrency0: false }).now).toBe(amount1);
    expect(positionQuote({ sqrtPriceX96: Q96, ...range, liquidity: L, quoteIsCurrency0: true }).now).toBe(amount0);
  });

  it("is not moved by the pool's price when it holds only tokens: no price gives them a value", () => {
    // Quote is currency1; the range is above the price, so the position is all currency0, the token.
    for (const tick of [-200_000, -6_000, -601]) {
      expect(positionQuote({ sqrtPriceX96: sqrtRatioAtTick(tick), ...range, liquidity: L, quoteIsCurrency0: false }).now).toBe(0n);
    }
    // The mirror, quote currency0: all currency1 when the raw price is above the range.
    expect(positionQuote({ sqrtPriceX96: sqrtRatioAtTick(700_000), ...range, liquidity: L, quoteIsCurrency0: true }).now).toBe(0n);
  });

  it("gains, while the token's price doubles, its quote at the doubled price less its quote now: token as currency0, the raw price doubles", () => {
    // From price 1 the doubled price (tick 6,931) is past the range's top: it ends holding only quote, all of L * (upper - lower).
    const all = (L * (upper - lower)) / Q96;
    const q = positionQuote({ sqrtPriceX96: Q96, ...range, liquidity: L, quoteIsCurrency0: false });
    expect(q.now + q.inflow).toBe(all);
    // A wide range the doubled price stays inside: the gain is L * (sqrtP' - sqrtP), by the liquidity math.
    const wide = positionQuote({ sqrtPriceX96: Q96, tickLower: -60_000, tickUpper: 60_000, liquidity: L, quoteIsCurrency0: false });
    expect(wide.inflow).toBe(amountsForLiquidity(up(Q96), sqrtRatioAtTick(-60_000), sqrtRatioAtTick(60_000), L).amount1 - wide.now);
    // sqrt 2 - 1 of L, to within the rounding of two floors.
    expect(wide.inflow - (L * 414_213_562_373_095_048n) / 10n ** 18n).toBeLessThan(3n);
    expect((L * 414_213_562_373_095_048n) / 10n ** 18n - wide.inflow).toBeLessThan(3n);
  });

  it("looks the other way when the token is currency1: its price doubling is the raw price halving", () => {
    const wide = { tickLower: -60_000, tickUpper: 60_000 };
    const q = positionQuote({ sqrtPriceX96: Q96, ...wide, liquidity: L, quoteIsCurrency0: true });
    expect(q.inflow).toBe(amountsForLiquidity(down(Q96), sqrtRatioAtTick(-60_000), sqrtRatioAtTick(60_000), L).amount0 - q.now);
    expect(q.inflow).toBeGreaterThan(0n);
    // Had it looked up instead of down, the quote would have shrunk and the inflow been cut to zero.
    expect(amountsForLiquidity(up(Q96), sqrtRatioAtTick(-60_000), sqrtRatioAtTick(60_000), L).amount0).toBeLessThan(q.now);
    // At price 1 the two orientations mirror each other.
    const mirrored = positionQuote({ sqrtPriceX96: Q96, ...wide, liquidity: L, quoteIsCurrency0: false });
    expect(q.inflow - mirrored.inflow).toBeLessThan(3n);
    expect(mirrored.inflow - q.inflow).toBeLessThan(3n);
  });

  it("gains nothing in a range the doubled price doesn't reach, or one the price has left on the token's upside", () => {
    // Token currency0: doubling ends at tick 6,931. A range from 7,000 up isn't reached; one below the price is all quote already.
    expect(positionQuote({ sqrtPriceX96: Q96, tickLower: 7_000, tickUpper: 8_000, liquidity: L, quoteIsCurrency0: false })).toEqual({ now: 0n, inflow: 0n, reach: 0n });
    const below = positionQuote({ sqrtPriceX96: Q96, tickLower: -1_200, tickUpper: -600, liquidity: L, quoteIsCurrency0: false });
    expect(below.now).toBeGreaterThan(0n);
    expect(below.inflow).toBe(0n);
    // Token currency1: the mirror.
    expect(positionQuote({ sqrtPriceX96: Q96, tickLower: -8_000, tickUpper: -7_000, liquidity: L, quoteIsCurrency0: true })).toEqual({ now: 0n, inflow: 0n, reach: 0n });
    expect(positionQuote({ sqrtPriceX96: Q96, tickLower: 600, tickUpper: 1_200, liquidity: L, quoteIsCurrency0: true }).inflow).toBe(0n);
  });

  it("takes part of the inflow when the doubled price ends inside the range, and is zero without liquidity or a price", () => {
    const part = positionQuote({ sqrtPriceX96: Q96, tickLower: 3_000, tickUpper: 12_000, liquidity: L, quoteIsCurrency0: false });
    expect(part.now).toBe(0n);
    expect(part.inflow).toBe((L * (up(Q96) - sqrtRatioAtTick(3_000))) / Q96);
    expect(positionQuote({ sqrtPriceX96: Q96, ...range, liquidity: 0n, quoteIsCurrency0: false })).toEqual({ now: 0n, inflow: 0n, reach: 0n });
    expect(positionQuote({ sqrtPriceX96: 0n, ...range, liquidity: L, quoteIsCurrency0: false })).toEqual({ now: 0n, inflow: 0n, reach: 0n });
  });
});

describe("one price for every pool: the token's square-root price", () => {
  it("is the raw price when the quote is currency1, its inverse when it is currency0, in 18-decimal quote units", () => {
    // Raw price 4 with 6-decimal USDC as currency1: 4 raw USDC a raw token is 4e12 in 18 decimals; its square root, 2e6.
    expect(tokenSqrtPrice(2n * Q96, false, 6)).toBe(2n * Q96 * 10n ** 6n);
    // The same raw price with USDC as currency0: a quarter of a raw USDC a raw token.
    expect(tokenSqrtPrice(2n * Q96, true, 6)).toBe((Q96 / 2n) * 10n ** 6n);
    // Native USDC already has 18 decimals.
    expect(tokenSqrtPrice(2n * Q96, false, 18)).toBe(2n * Q96);
    expect(tokenSqrtPrice(0n, false, 6)).toBe(0n);
  });

  it("gives two pools at the same market price the same figure, whatever their orientation and decimals", () => {
    // $0.001 a token (18 decimals). USDC-6 as currency1: raw price 1e-15. Native USDC-18 as currency0: raw price 1,000 tokens a USDC.
    const usdc6 = tokenSqrtPrice(sqrtRatioAtTick(-345_405), false, 6);
    const native = tokenSqrtPrice(sqrtRatioAtTick(69_081), true, 18);
    const ratio = Number((usdc6 * 10n ** 9n) / native) / 1e9;
    expect(ratio).toBeGreaterThan(0.999);
    expect(ratio).toBeLessThan(1.001);
  });

  it("turns back into the pool's own raw price", () => {
    for (const [sqrtP, quote0, decimals] of [[sqrtRatioAtTick(-345_405), false, 6], [sqrtRatioAtTick(69_081), true, 18], [sqrtRatioAtTick(12_345), true, 6], [Q96, false, 18]] as const) {
      const back = rawSqrtPriceAt(tokenSqrtPrice(sqrtP, quote0, decimals), quote0, decimals);
      expect(Number((back * 10n ** 12n) / sqrtP) / 1e12).toBeCloseTo(1, 9);
    }
    expect(rawSqrtPriceAt(0n, false, 6)).toBe(0n);
  });

  it("reads a v2 pair's from its reserves", () => {
    // 4 raw USDC a raw token.
    expect(v2TokenSqrtPrice(4_000_000n, 1_000_000n)).toBe(2n * Q96 * 10n ** 6n);
    expect(v2TokenSqrtPrice(4_000_000n, 0n)).toBe(0n);
  });

  it("doubles a price by sqrt 2", () => {
    const doubled = doubledPrice(Q96);
    expect(Number((doubled * doubled * 10n ** 9n) / (Q96 * Q96)) / 1e9).toBeCloseTo(2, 8);
  });
});

describe("positionQuote looking to a given price", () => {
  const L = 10n ** 18n;
  const wide = { tickLower: -60_000, tickUpper: 60_000, liquidity: L };
  it("gains the quote between the pool's price and the target, and nothing when the pool is already past it", () => {
    const up = sqrtRatioAtTick(3_000);
    // Token currency0: a higher raw price is a higher token price.
    const [lo, hi] = [sqrtRatioAtTick(-60_000), sqrtRatioAtTick(60_000)];
    expect(positionQuote({ sqrtPriceX96: Q96, ...wide, quoteIsCurrency0: false }, up).inflow).toBe(amountsForLiquidity(up, lo, hi, L).amount1 - amountsForLiquidity(Q96, lo, hi, L).amount1);
    expect(positionQuote({ sqrtPriceX96: up, ...wide, quoteIsCurrency0: false }, Q96).inflow).toBe(0n);
    // Token currency1: a lower raw price is a higher token price.
    const down = sqrtRatioAtTick(-3_000);
    expect(positionQuote({ sqrtPriceX96: Q96, ...wide, quoteIsCurrency0: true }, down).inflow).toBeGreaterThan(0n);
    expect(positionQuote({ sqrtPriceX96: down, ...wide, quoteIsCurrency0: true }, Q96).inflow).toBe(0n);
    expect(positionQuote({ sqrtPriceX96: Q96, ...wide, quoteIsCurrency0: false }, 0n).inflow).toBe(0n);
  });
});

describe("the hook's remove-liquidity permissions", () => {
  const hooked = (flags: string) => hookCanChangeRemoval(v4PoolKey("0x1111111111111111111111111111111111111111", USDC, 500, 10, `0x${"1".repeat(36)}${flags}`));
  it("reads BEFORE_REMOVE_LIQUIDITY (1 << 9), AFTER_REMOVE_LIQUIDITY (1 << 8) and AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA (1 << 0)", () => {
    expect(hooked("0200")).toBe(true);
    expect(hooked("0100")).toBe(true);
    expect(hooked("0001")).toBe(true);
  });
  it("is false for every other permission, and for no hook", () => {
    // Everything but bits 9, 8 and 0: initialize, add liquidity, swap, donate and the other deltas.
    expect(hooked("3cfe")).toBe(false);
    expect(hookCanChangeRemoval(v4PoolKey("0x1111111111111111111111111111111111111111", USDC, 500, 10))).toBe(false);
  });
});

const POOL_ID = `0x${"ab".repeat(32)}` as const;
const ZERO = "0x0000000000000000000000000000000000000000";
const SENDER = "0x00000000000000000000000000000000000a11ce";
const salt = (n: number): `0x${string}` => `0x${n.toString(16).padStart(64, "0")}`;
const modifyLog = (poolId: string, sender: string, tickLower: number, tickUpper: number, delta: bigint, s: `0x${string}`, block = 100n): ChainLog => ({
  topics: [MODIFY_LIQUIDITY_TOPIC, poolId as `0x${string}`, `0x${sender.slice(2).padStart(64, "0")}`],
  data: encodeAbiParameters([{ type: "int24" }, { type: "int24" }, { type: "int256" }, { type: "bytes32" }], [tickLower, tickUpper, delta, s]),
  blockNumber: block,
});

describe("positionFromLog", () => {
  it("has the event's topic0", () => {
    // keccak256("ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)"), as read in a log on Arc mainnet.
    expect(MODIFY_LIQUIDITY_TOPIC).toBe("0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec");
  });

  it("reads a real log: PositionManager NFT 332,087, full range, on pool 0x1505…f879 (Arc mainnet, block 32,211,901)", () => {
    const found = positionFromLog({
      topics: [MODIFY_LIQUIDITY_TOPIC, "0x1505e1ae7976e5c5d07ed89ab606edc66c6b0532b63a1cfbc82a3182ad02f879", "0x0000000000000000000000006049c9a0e26405c0985f9e3685c87d0ae917f82b"],
      data: "0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffff2762e00000000000000000000000000000000000000000000000000000000000d89d2000000000000000000000000000000000000000000022ee0e687744334dcf15a0000000000000000000000000000000000000000000000000000000000051137",
    });
    expect(found).toEqual({
      poolId: "0x1505e1ae7976e5c5d07ed89ab606edc66c6b0532b63a1cfbc82a3182ad02f879",
      key: { owner: "0x6049c9a0e26405c0985f9e3685c87d0ae917f82b", tickLower: -887_250, tickUpper: 887_250, salt: salt(0x51137) },
    });
  });

  it("is the same key whether liquidity was added or removed, and null for another event or a malformed log", () => {
    const added = positionFromLog(modifyLog(POOL_ID, SENDER, -60, 60, 5n, salt(7)));
    expect(positionFromLog(modifyLog(POOL_ID, SENDER, -60, 60, -5n, salt(7)))).toEqual(added);
    expect(positionFromLog({ ...modifyLog(POOL_ID, SENDER, -60, 60, 5n, salt(7)), topics: [`0x${"11".repeat(32)}`, POOL_ID, salt(1)] })).toBeNull();
    expect(positionFromLog({ topics: [MODIFY_LIQUIDITY_TOPIC, POOL_ID], data: "0x" })).toBeNull();
    expect(positionFromLog({ topics: [MODIFY_LIQUIDITY_TOPIC, POOL_ID, salt(1)], data: "0x1234" })).toBeNull();
  });
});

describe("isPositionKey", () => {
  const key: V4PositionKey = { owner: SENDER, tickLower: -60, tickUpper: 60, salt: salt(1) };
  it("accepts a key that can exist and refuses the rest", () => {
    expect(isPositionKey(key)).toBe(true);
    expect(isPositionKey({ ...key, owner: "0x12" })).toBe(false);
    expect(isPositionKey({ ...key, tickLower: 60, tickUpper: 60 })).toBe(false);
    expect(isPositionKey({ ...key, tickLower: -887_273 })).toBe(false);
    expect(isPositionKey({ ...key, tickUpper: 887_273 })).toBe(false);
    expect(isPositionKey({ ...key, tickLower: 0.5 })).toBe(false);
    expect(isPositionKey({ ...key, salt: "0x01" })).toBe(false);
    expect(isPositionKey(null)).toBe(false);
  });
});

describe("classifyHolder", () => {
  const LOCKER = "0x00000000000000000000000000000000000010c4";
  const context = (code: `0x${string}` | null | undefined) => ({ knownLockers: [LOCKER] as `0x${string}`[], code });
  it("knows burn addresses and the chain's lockers without reading code", () => {
    expect(classifyHolder("0x000000000000000000000000000000000000dEaD", context(undefined))).toBe("burned");
    expect(classifyHolder("0x0000000000000000000000000000000000000000", context(undefined))).toBe("burned");
    expect(classifyHolder(LOCKER.toUpperCase().replace("0X", "0x") as `0x${string}`, context(undefined))).toBe("locked");
  });
  it("calls an address without code a wallet, and an EIP-7702 delegation too", () => {
    expect(classifyHolder(SENDER, context(null))).toBe("wallet");
    expect(classifyHolder(SENDER, context(`0xef0100${"ab".repeat(20)}`))).toBe("wallet");
  });
  it("calls any other code a contract: never locked, never withdrawable", () => {
    expect(classifyHolder(SENDER, context("0x6080604052"))).toBe("contract");
    // 23 bytes that don't start with the delegation designator, and the designator at another length.
    expect(classifyHolder(SENDER, context(`0xef0200${"ab".repeat(20)}`))).toBe("contract");
    expect(classifyHolder(SENDER, context(`0xef0100${"ab".repeat(21)}`))).toBe("contract");
  });
  it("leaves a holder whose code wasn't read unclassified", () => {
    expect(classifyHolder(SENDER, context(undefined))).toBe("unclassified");
  });
});

describe("readHolderCode", () => {
  const holderAt = (i: number) => `0x${(i + 1).toString(16).padStart(40, "0")}` as `0x${string}`;
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ holder: holderAt(i), value: BigInt(i + 1) }));

  it("reads the holders' code in batches of 250 through the code reader, the largest first, up to 500 of them", async () => {
    const holders = many(MAX_HOLDER_CODE_READS + 5);
    const contract = holderAt(MAX_HOLDER_CODE_READS + 4);
    const delegated = holderAt(300);
    const reader = fakeChain({ code: { [contract]: `0x${"60".repeat(100)}`, [delegated]: `0xef0100${"ab".repeat(20)}` } });
    let single = 0;
    const counting = { ...reader, getCode: (a: `0x${string}`) => (single++, reader.getCode(a)) };
    const { code, unread } = await readHolderCode(counting, [...holders, { holder: "0x000000000000000000000000000000000000dEaD", value: 10n ** 9n }, { ...holders[9]!, value: 1n }], []);
    expect(MAX_HOLDER_CODE_READS).toBe(500);
    expect(reader.codeReads).toEqual([250, 250]);
    expect(single).toBe(0);
    expect(unread).toBe(5);
    // The five smallest are left out; a burn address is never asked about; holder 10 counts once, with both of its positions.
    for (const small of holders.slice(0, 5)) expect(code.has(small.holder)).toBe(false);
    expect(code.size).toBe(MAX_HOLDER_CODE_READS);
    // What comes back classifies: no code, a contract (its first 32 bytes are enough), an EIP-7702 delegation (23 bytes).
    expect(code.get(holderAt(20))).toBeNull();
    expect(classifyHolder(contract, { knownLockers: [], code: code.get(contract) })).toBe("contract");
    expect(code.get(contract)).toBe(`0x${"60".repeat(32)}`);
    expect(classifyHolder(delegated, { knownLockers: [], code: code.get(delegated) })).toBe("wallet");
  });

  it("falls back to reading the 40 largest one by one where the node won't run the code reader", async () => {
    const holders = many(60);
    const reader = fakeChain({ codeReaderFails: new Error("state override not supported"), code: { [holderAt(59)]: "0x6080" } });
    const asked: string[] = [];
    const { code, unread } = await readHolderCode({ ...reader, getCode: (a) => (asked.push(a), reader.getCode(a)) }, holders, []);
    expect(asked).toHaveLength(40);
    expect(unread).toBe(20);
    expect(code.get(holderAt(59))).toBe("0x6080");
    expect(code.has(holderAt(0))).toBe(false);
  });

  it("asks nothing when every holder is a burn address or a known locker", async () => {
    const LOCKER = "0x00000000000000000000000000000000000010c4";
    const reader = fakeChain();
    expect(await readHolderCode(reader, [{ holder: "0x000000000000000000000000000000000000dEaD", value: 1n }, { holder: LOCKER, value: 1n }], [LOCKER])).toEqual({ code: new Map(), unread: 0 });
    expect(reader.codeReads).toEqual([]);
  });

  it("decodes the reader's answer: a size and the first 32 bytes per address, and refuses an answer of another length", () => {
    const word = (n: bigint) => n.toString(16).padStart(64, "0");
    const answer = `0x${word(0n)}${"0".repeat(64)}${word(2n)}6080${"0".repeat(60)}${word(40n)}${"ab".repeat(32)}` as const;
    expect(decodeCodeReader(answer, 3)).toEqual([null, "0x6080", `0x${"ab".repeat(32)}`]);
    expect(decodeCodeReader(answer, 2)).toBeNull();
    expect(decodeCodeReader("0x", 1)).toBeNull();
    expect(CODE_READER).toHaveLength(2 + 46 * 2);
  });
});

describe("readV4Positions", () => {
  const TOKEN = "0x1111111111111111111111111111111111111111";
  const key = v4PoolKey(TOKEN, USDC, 500, 10);
  const id = v4PoolId(key);
  const pool: V4PoolRef = { poolId: id, key, quoteIsCurrency0: false, quoteDecimals: 6 };
  const PM = UNISWAP_V4.positionManager.toLowerCase();
  const WALLET = "0x00000000000000000000000000000000000B0b01"; // checksummed, as ownerOf decodes
  const nft = (tokenId: number, liquidity: bigint, tickLower = -600, tickUpper = 600): FakePosition => ({ owner: PM, tickLower, tickUpper, salt: salt(tokenId), liquidity });
  const keyOf = ({ owner, tickLower, tickUpper, salt: s }: FakePosition): V4PositionKey => ({ owner: owner as `0x${string}`, tickLower, tickUpper, salt: s as `0x${string}` });
  const L = 10n ** 12n;
  const HEAD = 1_000n;
  const index = (positions: FakePosition[], over: Partial<V4PositionIndex> & { truncated?: boolean } = {}): V4PositionIndex => ({
    cursor: over.cursor ?? Number(HEAD - HEAD_MARGIN),
    pools: over.pools ?? { [id]: { positions: positions.map(keyOf), truncated: over.truncated ?? false } },
  });
  const chain = (positions: FakePosition[], over: Parameters<typeof fakeChain>[0] = {}, active?: bigint) =>
    fakeChain({
      head: HEAD,
      v4: { [id]: { sqrtPriceX96: Q96, tick: 0, liquidity: active ?? positions.filter((p) => p.tickLower <= 0 && 0 < p.tickUpper).reduce((s, p) => s + p.liquidity, 0n), positions } },
      nftOwners: { 1: WALLET, 2: "0x000000000000000000000000000000000000dEaD" },
      ...over,
    });
  const readAll = (reader: ReturnType<typeof fakeChain>, idx: V4PositionIndex, pools = [pool]) => readV4Positions({ reader, v4: UNISWAP_V4, pools, index: idx, token: TOKEN, quotes: [USDC, ZERO] });
  const read = async (...args: Parameters<typeof readAll>) => (await readAll(...args)).pools;
  const topic = (address: string): `0x${string}` => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
  /** An Initialize of a pool `poolId` between two currencies, sorted as v4 sorts them. */
  const initialize = (poolId: string, a: string, b: string, block = 950n): ChainLog => {
    const [c0, c1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
    return { topics: [INITIALIZE_TOPIC, poolId as `0x${string}`, topic(c0), topic(c1)], data: "0x", blockNumber: block };
  };

  it("sizes each position that holds liquidity and names who can act on it: the NFT's owner, or the sender itself", async () => {
    const positions = [nft(1, L), nft(2, 3n * L), { owner: SENDER, tickLower: -60, tickUpper: 60, salt: salt(0), liquidity: L }, nft(3, 0n)];
    const reader = chain(positions);
    const [got] = await read(reader, index(positions));
    const held = (liquidity: bigint, tickLower: number, tickUpper: number) => ({
      quote: positionQuote({ sqrtPriceX96: Q96, tickLower, tickUpper, liquidity, quoteIsCurrency0: false }).now,
      tickLower,
      tickUpper,
      liquidity,
    });
    expect(got).toEqual({
      pool,
      gap: null,
      sqrtPriceX96: Q96,
      lpFee: 500,
      positions: [
        { holder: WALLET, tokenId: 1n, ...held(L, -600, 600) },
        { holder: "0x000000000000000000000000000000000000dEaD", tokenId: 2n, ...held(3n * L, -600, 600) },
        { holder: SENDER, tokenId: null, ...held(L, -60, 60) },
      ],
    });
    expect(held(L, -600, 600).quote).toBeGreaterThan(0n);
    // Everything at one block, a little behind the tip; and ownerOf only for the NFTs that hold liquidity.
    expect(new Set(reader.batchBlocks)).toEqual(new Set([HEAD - HEAD_MARGIN]));
    expect(reader.batches.flatMap((b) => b.calls).filter((c) => c.fn === "ownerOf").map((c) => c.args[0])).toEqual([1n, 2n]);
    expect(reader.logQueries).toEqual([]);
  });

  it("converts a native-USDC pool's 18-decimal amounts to 6", async () => {
    const positions = [{ owner: SENDER, tickLower: -600, tickUpper: 600, salt: salt(0), liquidity: 10n ** 24n }];
    const [got] = await read(chain(positions), index(positions), [{ ...pool, quoteDecimals: 18 }]);
    const raw = positionQuote({ sqrtPriceX96: Q96, tickLower: -600, tickUpper: 600, liquidity: 10n ** 24n, quoteIsCurrency0: false });
    expect(got).toMatchObject({ gap: null, positions: [{ quote: raw.now / 10n ** 12n, liquidity: 10n ** 24n }] });
  });

  it("reads the blocks after the index's cursor itself, and adds the positions they opened", async () => {
    const indexed = [nft(1, L)];
    const fresh = nft(2, 2n * L);
    const reader = chain([...indexed, fresh], { logs: [modifyLog(id, PM, -600, 600, 2n * L, salt(2), 950n), modifyLog(id, PM, -600, 600, 1n, salt(1), 950n), modifyLog(POOL_ID, PM, -600, 600, 1n, salt(9), 950n), modifyLog(id, PM, -600, 600, 1n, salt(77), 900n)] });
    const [got] = await read(reader, index(indexed, { cursor: 900 }));
    expect(got).toMatchObject({ gap: null, positions: [{ tokenId: 1n }, { tokenId: 2n }] });
    // Three questions of the same blocks: pools created with the token on either side, then the pools' positions.
    const tail = { address: UNISWAP_V4.poolManager, fromBlock: 901n, toBlock: HEAD - HEAD_MARGIN };
    expect(reader.logQueries).toEqual([
      { ...tail, topics: [INITIALIZE_TOPIC, null, topic(TOKEN)] },
      { ...tail, topics: [INITIALIZE_TOPIC, null, null, topic(TOKEN)] },
      { ...tail, topics: [MODIFY_LIQUIDITY_TOPIC, [id]] },
    ]);
  });

  it("names a pool of the token created since the cursor that it wasn't asked about, on either side of the pair", async () => {
    const HIGH = "0x9999999999999999999999999999999999999999"; // sorts above USDC: the token is then currency1
    const hookedId = `0x${"c1".repeat(32)}`;
    const logs = [
      initialize(hookedId, TOKEN, USDC),
      initialize(`0x${"c2".repeat(32)}`, TOKEN, ZERO),
      // Not against a quote currency: never counted, as before.
      initialize(`0x${"c3".repeat(32)}`, TOKEN, "0x128cC466B61f542da60c70e3aA11c10e19B84EDB"),
      // Asked about: nothing to say.
      initialize(id, TOKEN, USDC),
      // Before the tail: the index's business.
      initialize(`0x${"c4".repeat(32)}`, TOKEN, USDC, 900n),
      // Another token's pool.
      initialize(`0x${"c5".repeat(32)}`, HIGH, USDC),
    ];
    const got = await readAll(chain([nft(1, L)], { logs }), index([nft(1, L)], { cursor: 900 }));
    expect(got).toMatchObject({ stale: false, unlisted: [`0x${"c2".repeat(32)}`, hookedId].sort(), pools: [{ gap: null }] });
    const high = await readV4Positions({ reader: chain([], { logs }), v4: UNISWAP_V4, pools: [], index: { cursor: 900, pools: {} }, token: HIGH, quotes: [USDC, ZERO] });
    expect(high).toEqual({ pools: [], stale: false, unlisted: [`0x${"c5".repeat(32)}`] });
  });

  it("asks about new pools even with no pool to read, and nothing at all when the index is at the head", async () => {
    const reader = chain([]);
    expect(await readV4Positions({ reader, v4: UNISWAP_V4, pools: [], index: { cursor: 900, pools: {} }, token: TOKEN, quotes: [USDC] })).toEqual({ pools: [], stale: false, unlisted: [] });
    expect(reader.logQueries.map((q) => q.topics[0])).toEqual([INITIALIZE_TOPIC, INITIALIZE_TOPIC]);
    const caught = chain([]);
    await readV4Positions({ reader: caught, v4: UNISWAP_V4, pools: [], index: { cursor: Number(HEAD), pools: {} }, token: TOKEN, quotes: [USDC] });
    expect(caught.logQueries).toEqual([]);
    expect(await readV4Positions({ reader: chain([], { head: 50_000n }), v4: UNISWAP_V4, pools: [], index: { cursor: 0, pools: {} }, token: TOKEN, quotes: [USDC] })).toEqual({ pools: [], stale: true, unlisted: [] });
  });

  it("is stale when the cursor is more than 10,000 blocks behind, and reads nothing", async () => {
    const positions = [nft(1, L)];
    const reader = chain(positions, { head: 20_000n });
    expect(await read(reader, index(positions, { cursor: Number(20_000n - HEAD_MARGIN) - TAIL_MAX_BLOCKS - 1 }))).toEqual([{ pool, gap: "stale" }]);
    expect(reader.batches).toEqual([]);
    expect(reader.logQueries).toEqual([]);
    // Exactly 10,000 behind is still read.
    const edge = chain(positions, { head: 20_000n });
    expect(await read(edge, index(positions, { cursor: Number(20_000n - HEAD_MARGIN) - TAIL_MAX_BLOCKS }))).toMatchObject([{ gap: null }]);
    expect(await read(chain(positions), index(positions, { cursor: Number.NaN }))).toEqual([{ pool, gap: "stale" }]);
  });

  it("reads at its own block an index that is ahead of it: a position opened later holds nothing there yet", async () => {
    const positions = [nft(1, L)];
    const reader = chain(positions);
    expect(await read(reader, index(positions, { cursor: Number(HEAD) + 5 }))).toMatchObject([{ gap: null, positions: [{ tokenId: 1n }] }]);
    expect(reader.logQueries).toEqual([]);
  });

  it("reads a pool created after the cursor from the tail alone: no entry in the index is needed, and none is missing", async () => {
    const fresh = nft(2, L);
    const logs = [initialize(id, TOKEN, USDC, 940n), modifyLog(id, PM, -600, 600, L, salt(2), 950n)];
    const got = await readAll(chain([fresh], { logs }), { cursor: 900, pools: {} });
    expect(got).toMatchObject({ unlisted: [], pools: [{ gap: null, positions: [{ tokenId: 2n }] }] });
    // Created before the cursor and not in the index: missing, as ever.
    expect(await read(chain([fresh], { logs: [initialize(id, TOKEN, USDC, 900n)] }), { cursor: 900, pools: {} })).toEqual([{ pool, gap: "missing" }]);
  });

  it("gives up at the deadline: nothing is started after it, and an answer still missing at it is not waited for", async () => {
    const positions = [nft(1, L)];
    const late = chain(positions);
    await expect(readV4Positions({ reader: late, v4: UNISWAP_V4, pools: [pool], index: index(positions), token: TOKEN, quotes: [USDC], deadlineAt: Date.now() - 1 })).rejects.toBeInstanceOf(ReadsTimedOut);
    expect(late.batches).toEqual([]);
    const hung = chain(positions);
    const slow = { ...hung, read: () => new Promise<never>(() => {}) };
    await expect(readV4Positions({ reader: slow, v4: UNISWAP_V4, pools: [pool], index: index(positions), token: TOKEN, quotes: [USDC], deadlineAt: Date.now() + 30 })).rejects.toBeInstanceOf(ReadsTimedOut);
    await expect(readHolderCode({ ...hung, callWithOverride: () => new Promise<never>(() => {}) }, [{ holder: WALLET, value: 1n }], [], Date.now() + 30)).rejects.toBeInstanceOf(ReadsTimedOut);
    await expect(beforeDeadline(Date.now() + 1_000, async () => "in time")).resolves.toBe("in time");
    await expect(beforeDeadline(undefined, async () => "no deadline")).resolves.toBe("no deadline");
    await expect(beforeDeadline(Date.now() + 1_000, async () => Promise.reject(new Error("its own")))).rejects.toThrow("its own");
  });

  it("says missing for a pool the index didn't look up, which an empty list is not", async () => {
    const reader = chain([]);
    expect(await read(reader, index([], { pools: {} }))).toEqual([{ pool, gap: "missing" }]);
    expect(await read(chain([]), index([]))).toEqual([{ pool, gap: null, sqrtPriceX96: Q96, lpFee: 500, positions: [] }]);
    // An entry under an inherited name is no entry.
    expect(await read(chain([]), index([], { pools: Object.create({ [id]: { positions: [], truncated: false } }) as V4PositionIndex["pools"] }))).toEqual([{ pool, gap: "missing" }]);
  });

  it("says truncated when the index says so, or the pool has more positions than it reads", async () => {
    expect(await read(chain([nft(1, L)]), index([nft(1, L)], { truncated: true }))).toEqual([{ pool, gap: "truncated" }]);
    const many = Array.from({ length: MAX_POSITIONS_PER_POOL + 1 }, (_, i) => nft(i + 10, 0n));
    expect(await read(chain(many), index(many))).toEqual([{ pool, gap: "truncated" }]);
    // The tail can push a full list over the cap.
    const full = many.slice(0, MAX_POSITIONS_PER_POOL);
    const over = chain(full, { logs: [modifyLog(id, PM, -600, 600, 1n, salt(9_999), 950n)] });
    expect(await read(over, index(full, { cursor: 900 }))).toEqual([{ pool, gap: "truncated" }]);
  });

  it("stops at the total it reads over all pools: the pools past it are truncated, the ones before are read", async () => {
    const pools = Array.from({ length: 5 }, (_, i) => {
      const k = v4PoolKey(TOKEN, USDC, 100 + i, 10);
      return { poolId: v4PoolId(k), key: k, quoteIsCurrency0: false, quoteDecimals: 6 } satisfies V4PoolRef;
    });
    const each = Array.from({ length: MAX_POSITIONS_PER_POOL }, (_, i) => nft(i + 1, 0n));
    const reader = fakeChain({ head: HEAD, v4: Object.fromEntries(pools.map((p) => [p.poolId, { sqrtPriceX96: Q96, tick: 0, liquidity: 0n, positions: each }])) });
    const got = await read(reader, { cursor: Number(HEAD), pools: Object.fromEntries(pools.map((p) => [p.poolId, { positions: each.map(keyOf), truncated: false }])) }, pools);
    expect(MAX_POSITIONS).toBe(4 * MAX_POSITIONS_PER_POOL);
    expect(got.map((r) => r.gap)).toEqual([null, null, null, null, "truncated"]);
  });

  it("says mismatch when the in-range positions don't add up to the pool's active liquidity", async () => {
    const positions = [nft(1, L), nft(2, L, 600, 1200)];
    // One more position is in range on chain than the list has.
    expect(await read(chain(positions, {}, 2n * L), index(positions))).toEqual([{ pool, gap: "mismatch" }]);
    // The out-of-range one doesn't count toward it: tickLower <= tick < tickUpper.
    expect(await read(chain(positions, {}, L), index(positions))).toMatchObject([{ gap: null }]);
    const edges = [nft(1, L, 0, 600), nft(2, L, -600, 0)];
    expect(await read(chain(edges, {}, L), index(edges))).toMatchObject([{ gap: null }]);
  });

  it("says unreadable when a list entry is malformed, a position doesn't answer, or an NFT with liquidity has no owner", async () => {
    const positions = [nft(1, L)];
    const bad = index(positions);
    bad.pools[id]!.positions.push({ owner: "0x12", tickLower: 0, tickUpper: 1, salt: salt(1) } as V4PositionKey);
    expect(await read(chain(positions), bad)).toEqual([{ pool, gap: "unreadable" }]);
    expect(await read(chain(positions, { positionInfoFails: true }), index(positions))).toEqual([{ pool, gap: "unreadable" }]);
    expect(await read(chain(positions, { nftOwners: {} }), index(positions))).toEqual([{ pool, gap: "unreadable" }]);
    expect(await read(chain(positions, { multicallReverts: true }), index(positions))).toEqual([{ pool, gap: "unreadable" }]);
  });

  it("rejects when the network fails: the tail's logs, or a multicall", async () => {
    const positions = [nft(1, L)];
    await expect(read(chain(positions, { logs: new Error("boom") }), index(positions, { cursor: 900 }))).rejects.toThrow("boom");
    await expect(read(chain(positions, { multicallError: new Error("down") }), index(positions))).rejects.toThrow("down");
  });

  it("splits a long list over several multicalls", async () => {
    const positions = Array.from({ length: 450 }, (_, i) => nft(i + 1, 0n));
    const reader = chain(positions);
    expect(await read(reader, index(positions))).toEqual([{ pool, gap: null, sqrtPriceX96: Q96, lpFee: 500, positions: [] }]);
    expect(reader.batches.map((b) => b.calls.length)).toEqual([200, 200, 52]);
  });
});
