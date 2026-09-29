import { encodeAbiParameters, getAddress, keccak256, parseAbi } from "viem";
import type { Address } from "@arcos/chain";
import type { Hex } from "./bytecode";
import type { PoolKey } from "./types";

/** v4's native currency: address(0). On Arc that is USDC, with 18 decimals. */
export const NATIVE: Address = "0x0000000000000000000000000000000000000000";

/** The fee and tick spacing pairs Inspector probes without an index: the ones most pools on Arc launch with (design F17). */
export const STANDARD_V4_TIERS = [
  { fee: 100, tickSpacing: 1 },
  { fee: 500, tickSpacing: 10 },
  { fee: 2500, tickSpacing: 50 },
  { fee: 3000, tickSpacing: 60 },
  { fee: 10000, tickSpacing: 200 },
] as const;

export const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);

export const quoterAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactOutputSingle(QuoteExactSingleParams params) returns (uint256 amountIn, uint256 gasEstimate)",
]);

const lower = (a: string) => a.toLowerCase();
const checksummed = (a: Address): Address => getAddress(lower(a) as Address);

/** A pool key for two currencies: sorted (currency0 is the numerically smaller address), checksummed, hookless unless told. */
export function v4PoolKey(a: Address, b: Address, fee: number, tickSpacing: number, hooks: Address = NATIVE): PoolKey {
  const [currency0, currency1] = lower(a) < lower(b) ? [a, b] : [b, a];
  return { currency0: checksummed(currency0), currency1: checksummed(currency1), fee, tickSpacing, hooks: checksummed(hooks) };
}

/** keccak256(abi.encode(PoolKey)): what the PoolManager calls the pool, and what StateView is keyed by. */
export function v4PoolId(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

/** Every standard hookless key for `token` against each quote currency. */
export function standardV4Keys(token: Address, quoteCurrencies: readonly Address[]): PoolKey[] {
  return quoteCurrencies.flatMap((quote) => STANDARD_V4_TIERS.map((t) => v4PoolKey(token, quote, t.fee, t.tickSpacing)));
}

const Q96 = 1n << 96n;
const PRECISION = 256n;
const ONE = 1n << PRECISION;
const STEP_UP = (10_001n << PRECISION) / 10_000n;
const STEP_DOWN = (10_000n << PRECISION) / 10_001n;

/** Integer square root (Newton), rounded down. */
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << BigInt((n.toString(2).length + 1) >> 1);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/**
 * floor(sqrt(1.0001^tick) * 2^96), from the definition: 1.0001^|tick| by squaring in 256-bit fixed point, then a square
 * root. Not a port of Uniswap's TickMath (a table of rounded constants, under a different licence): this is the exact
 * value, which TickMath approximates to about 3e-20 at the extreme ticks and rounds up by one at the lowest. Only the depth
 * figure below uses it.
 */
export function sqrtRatioAtTick(tick: number): bigint {
  let ratio = ONE;
  let step = tick < 0 ? STEP_DOWN : STEP_UP;
  for (let e = Math.abs(tick); e > 0; e >>= 1) {
    if (e & 1) ratio = (ratio * step) >> PRECISION;
    step = (step * step) >> PRECISION;
  }
  return isqrt((ratio << 192n) >> PRECISION);
}

/**
 * What "in range" means for a v4 pool's depth. With `s` the tick spacing, `t` the current tick, `tickLower = floor(t / s) * s`
 * and `tickUpper = tickLower + s`, the active liquidity `L` is the same throughout (tickLower, tickUpper): initialised ticks
 * are multiples of `s`, so none lies inside. This is the amount of the quote currency that `L` holds between the current
 * price `P` and the edge of that range a swap reaches when it takes the quote currency out:
 * - quote is currency1 (the price moves down to tickLower): L * (P - sqrt(tickLower)) / 2^96
 * - quote is currency0 (the price moves up to tickUpper):   L * 2^96 * (sqrt(tickUpper) - P) / (sqrt(tickUpper) * P)
 * in raw units of that currency, rounded down. An exact figure for that range and nothing more: liquidity in other ranges
 * isn't counted, so it can be far less than what the pool can pay out. It is shown as "in range". Whether a pool is liquid is
 * the quoter's answer, never this.
 */
export function quoteInRange(p: { sqrtPriceX96: bigint; tick: number; tickSpacing: number; liquidity: bigint; quoteIsCurrency0: boolean }): bigint {
  const tickLower = Math.floor(p.tick / p.tickSpacing) * p.tickSpacing;
  if (p.quoteIsCurrency0) {
    const upper = sqrtRatioAtTick(tickLower + p.tickSpacing);
    return p.sqrtPriceX96 >= upper ? 0n : (p.liquidity * Q96 * (upper - p.sqrtPriceX96)) / (upper * p.sqrtPriceX96);
  }
  const lowerRatio = sqrtRatioAtTick(tickLower);
  return p.sqrtPriceX96 <= lowerRatio ? 0n : (p.liquidity * (p.sqrtPriceX96 - lowerRatio)) / Q96;
}
