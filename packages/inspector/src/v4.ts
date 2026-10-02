import { decodeAbiParameters, encodeAbiParameters, getAddress, isAddress, keccak256, parseAbi } from "viem";
import type { Address, UniswapV4Config } from "@arcos/chain";
import type { Hex } from "./bytecode";
import { multicall, type BatchCall, type BatchResult } from "./multicall";
import { CallReverted, type ChainReader, type ExtraPool, type Pool, type PoolKey } from "./types";

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

/** A currency pools can quote against, with the decimals its amounts carry: 6 for USDC's ERC-20 view and EURC, 18 for native USDC. */
export type V4Quote = { address: Address; symbol: string; decimals: number };

export type V4Read = {
  /** StateView answered at least one question with something it could be decoded from: the contracts are there. */
  answered: boolean;
  pools: Pool[];
};

/** The index may list many pools for one token; one multicall carries no more than this many of them. */
const MAX_EXTRA_POOLS = 50;
const MAX_FEE = 2 ** 24 - 1; // a uint24
const MAX_TICK_SPACING = 32767; // v4 allows 1 to 32767

type Candidate = { key: PoolKey; id: Hex; quote: V4Quote; quoteIsCurrency0: boolean };

/** An entry from the index, normalised; null when it can't be a pool of this token against a quote currency. */
function usable(key: PoolKey, token: Address, quotes: readonly V4Quote[]): { key: PoolKey; quote: V4Quote } | null {
  const { currency0, currency1, hooks, fee, tickSpacing } = key;
  if (![currency0, currency1, hooks].every((a) => typeof a === "string" && isAddress(a, { strict: false }))) return null;
  if (!Number.isInteger(fee) || fee < 0 || fee > MAX_FEE) return null;
  if (!Number.isInteger(tickSpacing) || tickSpacing < 1 || tickSpacing > MAX_TICK_SPACING) return null;
  if (lower(currency0) >= lower(currency1)) return null; // v4 sorts the currencies; a key that doesn't is another pool id
  const other = lower(currency0) === lower(token) ? currency1 : lower(currency1) === lower(token) ? currency0 : null;
  const quote = other === null ? undefined : quotes.find((q) => lower(q.address) === lower(other));
  return quote ? { key: v4PoolKey(currency0, currency1, fee, tickSpacing, hooks), quote } : null;
}

/**
 * The standard hookless keys for every quote currency, then the index's pools that are usable, each pool once. The cap on
 * the index's pools counts the ones that survive validation and dedupe, so junk entries can't crowd real ones out.
 */
function candidates(token: Address, quotes: readonly V4Quote[], extra: readonly ExtraPool[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  const add = (key: PoolKey, quote: V4Quote): boolean => {
    const id = v4PoolId(key);
    if (seen.has(id)) return false;
    seen.add(id);
    out.push({ key, id, quote, quoteIsCurrency0: lower(key.currency0) === lower(quote.address) });
    return true;
  };
  for (const quote of quotes) for (const t of STANDARD_V4_TIERS) add(v4PoolKey(token, quote.address, t.fee, t.tickSpacing), quote);
  let taken = 0;
  for (const e of extra) {
    if (taken >= MAX_EXTRA_POOLS) break;
    const found = e.version === "v4" ? usable(e.key, token, quotes) : null;
    if (found && add(found.key, found.quote)) taken++;
  }
  return out;
}

const toSixDecimals = (raw: bigint, decimals: number): bigint =>
  decimals >= 6 ? raw / 10n ** BigInt(decimals - 6) : raw * 10n ** BigInt(6 - decimals);

/**
 * The gas one quote may use. Measured on Arc mainnet (eth_call, block 23,825,212): an honest 1,000-unit quote on the USDC/EURC
 * 0.05% pool needs about 62,500 gas in either direction, while a quote that walks an empty tick-spacing-1 pool's tick words
 * takes 10-25M and runs out of this limit (an empty inner reason, so undecided). 2M leaves room for a quote that crosses
 * many initialised ticks or runs a hook, and keeps any one pool far below the ~30M an eth_call gets.
 */
export const QUOTE_GAS = 2_000_000n;

/** V4Quoter wraps whatever its inner call reverted with in `UnexpectedRevertBytes(bytes)`. */
const UNEXPECTED_REVERT_BYTES = "0x6190b2b0";
/** `NotEnoughLiquidity(bytes32 poolId)`: the pool's own "I can't pay that". */
const NOT_ENOUGH_LIQUIDITY = "0x7a5ed734";
/**
 * v4-core `src/libraries/Hooks.sol`: a hook's permissions are the low 14 bits of its address, and
 * `BEFORE_SWAP_RETURNS_DELTA_FLAG = 1 << 3`, `AFTER_SWAP_RETURNS_DELTA_FLAG = 1 << 2`. A before-swap delta can claim the
 * exact output without the pool paying it (V4Quoter reverts with the quote before the settlement check); an after-swap delta
 * re-prices what the swapper owes.
 */
const HOOK_DELTA_FLAGS = 0b1100n;

/** True only for the pool's own NotEnoughLiquidity, for this pool: anything else (an inner out-of-gas, another error) says nothing. */
function isPoolShort(data: Hex | null, poolId: Hex): boolean {
  if (!data || lower(data).slice(0, 10) !== UNEXPECTED_REVERT_BYTES) return false;
  try {
    const [inner] = decodeAbiParameters([{ type: "bytes" }], `0x${data.slice(10)}`);
    return inner.length === 2 + 36 * 2 && lower(inner).slice(0, 10) === NOT_ENOUGH_LIQUIDITY && lower(`0x${inner.slice(10)}`) === lower(poolId);
  } catch {
    return false;
  }
}

/**
 * `token`'s v4 pools against each quote currency: two round trips for the state, then one quote per pool that exists.
 * 1. One multicall of `StateView.getSlot0` and `getLiquidity` for every candidate: the standard hookless keys and the
 *    index's pools. A pool whose `sqrtPriceX96` is 0 was never initialised.
 * 2. For each pool that exists, a V4Quoter exact-output quote for `quoteUnits` of the quote currency, as its own eth_call
 *    with `QUOTE_GAS`: a quote walks tick words, so one pool that plants an empty tick-spacing-1 range would starve the
 *    others in a shared call, and its failure stays its own. Only the pool's own NotEnoughLiquidity means it can't pay
 *    (`liquid: false`). A quote that fails otherwise leaves it undecided (`liquid: null`, "quote-unavailable"). A quote
 *    through a hook that can return a delta is unverified, since the hook can claim the output without the pool paying it
 *    (`liquid: null`, "hook-delta"). `depth` is the in-range amount, shown as such; it doesn't decide anything.
 * A Multicall3 that reverts as a whole reads as "nothing answered" (`answered: false`); a transport failure there rejects.
 */
export async function readV4Pools(a: {
  reader: ChainReader;
  v4: UniswapV4Config;
  token: Address;
  quotes: readonly V4Quote[];
  extra: readonly ExtraPool[];
  /** How many units of the quote currency a liquid pool must pay out. */
  quoteUnits: bigint;
}): Promise<V4Read> {
  const asked = candidates(a.token, a.quotes, a.extra);
  if (asked.length === 0) return { answered: false, pools: [] };
  let state: BatchResult[];
  try {
    state = await multicall(
      a.reader,
      asked.flatMap((c): BatchCall[] => [
        { target: a.v4.stateView, abi: stateViewAbi, functionName: "getSlot0", args: [c.id] },
        { target: a.v4.stateView, abi: stateViewAbi, functionName: "getLiquidity", args: [c.id] },
      ]),
    );
  } catch (e) {
    if (e instanceof CallReverted) return { answered: false, pools: [] };
    throw e;
  }
  const answered = asked.some((_, i) => state[i * 2]!.ok);
  const live = asked.flatMap((c, i) => {
    const slot = state[i * 2]!;
    if (!slot.ok) return [];
    const [sqrtPriceX96, tick] = slot.value as readonly [bigint, number, number, number];
    if (sqrtPriceX96 <= 0n) return [];
    const liquidity = state[i * 2 + 1]!;
    // A liquidity read that failed inside an answered multicall is a depth of 0, never a made-up figure.
    return [{ ...c, sqrtPriceX96, tick, liquidity: liquidity.ok ? (liquidity.value as bigint) : 0n }];
  });
  if (live.length === 0) return { answered, pools: [] };

  const pools = await Promise.all(
    live.map(async (c): Promise<Pool> => {
      const held = quoteInRange({ sqrtPriceX96: c.sqrtPriceX96, tick: c.tick, tickSpacing: c.key.tickSpacing, liquidity: c.liquidity, quoteIsCurrency0: c.quoteIsCurrency0 });
      const base = { address: a.v4.poolManager, version: "v4" as const, quote: c.quote.symbol, depth: toSixDecimals(held, c.quote.decimals), poolId: c.id, key: c.key };
      try {
        // The quote currency comes out: if it is currency1 the swap sells currency0 for it, and the other way round.
        const params = { poolKey: c.key, zeroForOne: !c.quoteIsCurrency0, exactAmount: a.quoteUnits * 10n ** BigInt(c.quote.decimals), hookData: "0x" };
        await a.reader.read(a.v4.quoter, quoterAbi, "quoteExactOutputSingle", [params], { gas: QUOTE_GAS });
        return (BigInt(c.key.hooks) & HOOK_DELTA_FLAGS) !== 0n ? { ...base, liquid: null, undecided: "hook-delta" } : { ...base, liquid: true };
      } catch (e) {
        if (e instanceof CallReverted && isPoolShort(e.data, c.id)) return { ...base, liquid: false };
        return { ...base, liquid: null, undecided: "quote-unavailable" };
      }
    }),
  );
  return { answered, pools };
}
