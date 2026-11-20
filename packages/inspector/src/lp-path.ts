import { amountsForLiquidity, doubledPrice, positionQuote, rawSqrtPriceAt, tokenSqrtPrice } from "./v4-positions";
import { isqrt, sqrtRatioAtTick, toSixDecimals } from "./v4";

// Where buyers' money goes, in the order it would arrive. Every position that sells tokens above its pool's price is an
// "ask": between two token prices it takes a known amount of the quote currency (the liquidity math is exact, and in the
// square root of the token's price it is a straight line). A buyer takes the tokens that cost him least, so all the asks
// of a token's pools, put on one axis of what a buyer pays per token (the pool's price divided by one minus its LP fee),
// form one path: at each price along it, how much quote has gone into positions so far, and whose. The lp-lock check
// reads that path, not a sum: a wallet whose range is first in line takes the first buyers' money whatever sits further up.
//
// Prices are token square-root prices on the common scale of v4-positions.ts (`tokenSqrtPrice`), times the fee factor;
// amounts are the quote currency in 6 decimals times `SHARE_SCALE` (what goes into the position, the fee left out);
// token amounts are raw units.

/**
 * Who a slice of liquidity belongs to, for the verdict.
 * - `burned`, `locked`: in a plain pool, at a burn address or in a known locker;
 * - `withdrawable`: a wallet's, in a plain pool;
 * - `elsewhere`: a wallet's, in a pool that isn't plain (a hook that runs in swaps, a dynamic or high fee, an EURC
 *   quote): the wallet can withdraw it, but whether a buyer ever reaches it is the pool's to decide;
 * - `doubted`: burned or locked, in such a pool;
 * - the rest are the other kinds of "not a wallet's, not safe either".
 */
export type HolderClass = "burned" | "locked" | "withdrawable" | "elsewhere" | "doubted" | "contract" | "hook" | "venue" | "unclassified" | "unvetted";
export const HOLDER_CLASSES: readonly HolderClass[] = ["burned", "locked", "withdrawable", "elsewhere", "doubted", "contract", "hook", "venue", "unclassified", "unvetted"];
export type ClassSums = Record<HolderClass, bigint>;
export const noSums = (): ClassSums => ({ burned: 0n, locked: 0n, withdrawable: 0n, elsewhere: 0n, doubted: 0n, contract: 0n, hook: 0n, venue: 0n, unclassified: 0n, unvetted: 0n });

/** LP fees are in pips, millionths. */
const PIPS = 1_000_000n;
const E18 = 10n ** 18n;
/**
 * sqrt(1 / (1 - fee)) with 18 decimals: what a pool's square-root price is multiplied by to give the square root of what
 * a buyer pays per token there. A fee of 100% (or more, which no pool has) is read as one pip short of it.
 */
export function feeFactor(feePips: number): bigint {
  const fee = BigInt(Math.max(0, Math.min(Math.trunc(feePips), Number(PIPS) - 1)));
  return isqrt((PIPS * E18 * E18) / (PIPS - fee));
}

/** Slopes are kept times 2^128, so a quote amount per unit of square-root price loses nothing that matters. */
const SLOPE_BITS = 128n;

/**
 * One position's token side as buyers meet it: from `lo` (the pool's price, or the range's lower edge when that is
 * higher) to `hi` (the range's upper edge; null for a Uniswap v2 pair, which sells all the way up), it takes
 * `slope * (to - from) >> 128` of quote between two prices. `tokensAbove(q)` is the tokens it still holds once the
 * price has reached `q`. Prices here are what a buyer pays, the pool's LP fee included.
 */
export type Ask = {
  owner: HolderClass;
  lo: bigint;
  hi: bigint | null;
  slope: bigint;
  tokensAbove: (price: bigint) => bigint;
};

/** A Uniswap v4 position's ask, or null when it sells nothing above the pool's price. `scale` multiplies its 6-decimal quote amounts. */
export function v4Ask(p: {
  owner: HolderClass;
  sqrtPriceX96: bigint;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  quoteIsCurrency0: boolean;
  quoteDecimals: number;
  /** The pool's LP fee now, in pips. */
  feePips: number;
  scale: bigint;
}): Ask | null {
  if (p.sqrtPriceX96 <= 0n || p.liquidity <= 0n) return null;
  const { quoteIsCurrency0: q0, quoteDecimals: d } = p;
  // The range's two edges as token prices. With the token as currency1 a higher raw price is a lower token price.
  const [rawLow, rawHigh] = [sqrtRatioAtTick(p.tickLower), sqrtRatioAtTick(p.tickUpper)];
  const [edgeLo, edgeHi, rawTop] = q0 ? [tokenSqrtPrice(rawHigh, q0, d), tokenSqrtPrice(rawLow, q0, d), rawLow] : [tokenSqrtPrice(rawLow, q0, d), tokenSqrtPrice(rawHigh, q0, d), rawHigh];
  const now = tokenSqrtPrice(p.sqrtPriceX96, q0, d);
  const midLo = now > edgeLo ? now : edgeLo;
  if (edgeHi <= midLo) return null;
  const factor = feeFactor(p.feePips);
  const [lo, hi] = [(midLo * factor) / E18, (edgeHi * factor) / E18];
  if (hi <= lo) return null;
  // Everything buyers pay into it on the way to the top of its range, exact.
  const range = { sqrtPriceX96: p.sqrtPriceX96, tickLower: p.tickLower, tickUpper: p.tickUpper, liquidity: p.liquidity, quoteIsCurrency0: q0 };
  const capacity = toSixDecimals(positionQuote(range, rawTop).inflow, d) * p.scale;
  const tokensAt = (raw: bigint) => {
    const { amount0, amount1 } = amountsForLiquidity(raw, rawLow, rawHigh, p.liquidity);
    return q0 ? amount1 : amount0;
  };
  return {
    owner: p.owner,
    lo,
    hi,
    slope: (capacity << SLOPE_BITS) / (hi - lo),
    tokensAbove: (price) => (price <= lo ? tokensAt(p.sqrtPriceX96) : price >= hi ? 0n : tokensAt(rawSqrtPriceAt((price * E18) / factor, q0, d))),
  };
}

/** Uniswap v2's fee: 0.3%, in every pair. */
const V2_FEE_PIPS = 3_000;

/**
 * A share of a Uniswap v2 pair as an ask: x * y = k, so the quote reserve grows with the square root of the price, by
 * `reserve / price` per unit of it, for ever, and the token reserve shrinks as `price / q`. `price` is the pair's own
 * square-root price, `reserve` the share's quote (scaled), `tokens` its tokens (raw). Null for a pair without tokens or
 * a price.
 */
export function v2Ask(p: { owner: HolderClass; price: bigint; reserve: bigint; tokens: bigint }): Ask | null {
  if (p.price <= 0n || p.tokens <= 0n || p.reserve <= 0n) return null;
  const lo = (p.price * feeFactor(V2_FEE_PIPS)) / E18;
  return {
    owner: p.owner,
    lo,
    hi: null,
    slope: (p.reserve << SLOPE_BITS) / lo,
    tokensAbove: (q) => (q <= lo ? p.tokens : (p.tokens * lo) / q),
  };
}

/** The path as the verdict reads it. */
export type AskPath = {
  /** The asks reach `minDepth` of quote: there is a window. Otherwise the whole path is the one prefix. */
  reached: boolean;
  /** The price at which `minDepth` has been paid in (P1), and the window's end, twice that price. Null when not reached. */
  p1: bigint | null;
  windowEnd: bigint | null;
  /** The quote paid in, by owner, from the path's start to each point checked: P1, every edge inside the window, its end. */
  prefixes: ClassSums[];
  /** The tokens the window sells, all owners together (raw units). */
  windowTokens: bigint;
  /** The tokens still for sale beyond the window's end, by owner (raw units). Nothing when there is no window. */
  beyond: ClassSums;
};

/** Quote paid into `asks` from `start` (the cheapest of them), by owner, at each of `points` (ascending). */
function paidAt(asks: readonly Ask[], start: bigint, points: readonly bigint[]): ClassSums[] {
  // Stops: every point, and every edge at which an ask starts or stops taking money.
  type Event = { at: bigint; owner: HolderClass; slope: bigint };
  const events: Event[] = [];
  const last = points[points.length - 1]!;
  for (const ask of asks) {
    const from = ask.lo > start ? ask.lo : start;
    if (from >= last || (ask.hi !== null && ask.hi <= from)) continue;
    events.push({ at: from, owner: ask.owner, slope: ask.slope });
    if (ask.hi !== null && ask.hi < last) events.push({ at: ask.hi, owner: ask.owner, slope: -ask.slope });
  }
  events.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
  const active = noSums();
  const paid = noSums(); // times 2^128
  const out: ClassSums[] = [];
  let at = start;
  let next = 0;
  const advance = (to: bigint) => {
    if (to > at) for (const owner of HOLDER_CLASSES) if (active[owner] !== 0n) paid[owner] += active[owner] * (to - at);
    if (to > at) at = to;
  };
  for (const point of points) {
    while (next < events.length && events[next]!.at <= point) {
      advance(events[next]!.at);
      active[events[next]!.owner] += events[next]!.slope;
      next++;
    }
    advance(point);
    const snapshot = noSums();
    for (const owner of HOLDER_CLASSES) snapshot[owner] = paid[owner] >> SLOPE_BITS;
    out.push(snapshot);
  }
  return out;
}

const total = (sums: ClassSums): bigint => HOLDER_CLASSES.reduce((s, owner) => s + sums[owner], 0n);

/**
 * The path over `asks`, or null when nothing is for sale.
 * - It starts at the cheapest price at which any of them sells. P1 is the price at which they have taken `minDepth` of
 *   quote; the window runs from the start to twice the price at P1.
 * - Shares are read at P1, at the window's end, and at every edge in between. Between two edges the mix is constant
 *   (every ask's take is a straight line in the square root of the price), so those points are the whole truth about
 *   every prefix from P1 to the end.
 * - When the asks never take `minDepth`, there is no window: the whole path is one prefix.
 */
export function findPath(asks: readonly Ask[], minDepth: bigint): AskPath | null {
  if (asks.length === 0) return null;
  const start = asks.reduce((m, a) => (a.lo < m ? a.lo : m), asks[0]!.lo);

  // P1: walk the edges upward, and past the last of them in doublings of the price (a v2 pair sells for ever).
  const edges = new Set<bigint>();
  for (const a of asks) {
    if (a.lo > start) edges.add(a.lo);
    if (a.hi !== null) edges.add(a.hi);
  }
  let far = [...edges].reduce((m, e) => (e > m ? e : m), start);
  const endless = asks.some((a) => a.hi === null);
  for (let i = 0; endless && i < 128; i++) edges.add((far = far * 2n));
  const stops = [...edges].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const taken = paidAt(asks, start, stops).map(total);
  const reachedAt = taken.findIndex((sum) => sum >= minDepth);

  // Every ask's own edges, for the points inside the window.
  const inside = (from: bigint, to: bigint): bigint[] => {
    const points = new Set<bigint>([to]);
    for (const a of asks) for (const edge of [a.lo, a.hi]) if (edge !== null && edge > from && edge < to) points.add(edge);
    return [...points].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  };
  if (reachedAt === -1) {
    // Thin: everything there is, as one prefix. An endless ask was walked to the top of the ladder above.
    const top = asks.reduce((m, a) => (a.hi !== null && a.hi > m ? a.hi : m), far);
    return { reached: false, p1: null, windowEnd: null, prefixes: paidAt(asks, start, [top]), windowTokens: 0n, beyond: noSums() };
  }
  const [prev, prevTaken] = reachedAt === 0 ? [start, 0n] : [stops[reachedAt - 1]!, taken[reachedAt - 1]!];
  const [here, hereTaken] = [stops[reachedAt]!, taken[reachedAt]!];
  // Between two edges the take is a straight line: where on it `minDepth` falls. Rounded up, so that it is reached.
  const p1 = hereTaken === prevTaken ? here : prev + ((minDepth - prevTaken) * (here - prev) + (hereTaken - prevTaken) - 1n) / (hereTaken - prevTaken);
  const windowEnd = doubledPrice(p1);
  const points = [p1, ...inside(p1, windowEnd)];
  const beyond = noSums();
  let windowTokens = 0n;
  for (const a of asks) {
    const left = a.tokensAbove(windowEnd);
    beyond[a.owner] += left;
    const from = a.lo > start ? a.lo : start;
    if (from < windowEnd) windowTokens += a.tokensAbove(from) - left;
  }
  return { reached: true, p1, windowEnd, prefixes: paidAt(asks, start, points), windowTokens, beyond };
}
