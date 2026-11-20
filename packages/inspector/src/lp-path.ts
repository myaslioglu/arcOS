import { amountsForLiquidity, doubledPrice, positionQuote, rawSqrtPriceAt, tokenSqrtPrice } from "./v4-positions";
import { sqrtRatioAtTick, toSixDecimals } from "./v4";

// Where buyers' money goes, in the order it would arrive. Every position that sells tokens above its pool's price is an
// "ask": between two token prices it takes a known amount of the quote currency (the liquidity math is exact, and in the
// square root of the token's price it is a straight line). Buyers are routed to the cheapest tokens first, so all the
// asks of all a token's pools, put on one price axis, form one path: at each price along it, how much quote has been
// paid in so far, and to whom. The lp-lock verdict reads that path, not a sum: a wallet whose range is first in line
// takes the first buyers' money whatever sits further up.
//
// Prices are token square-root prices on the common scale of v4-positions.ts (`tokenSqrtPrice`); amounts are the quote
// currency in 6 decimals times `SHARE_SCALE`; token amounts are raw units.

/** Who a slice of liquidity belongs to, for the verdict. The last six are the kinds of "unknown". */
export type HolderClass = "burned" | "locked" | "withdrawable" | "contract" | "hook" | "swapHook" | "venue" | "unclassified" | "unvetted";
export const HOLDER_CLASSES: readonly HolderClass[] = ["burned", "locked", "withdrawable", "contract", "hook", "swapHook", "venue", "unclassified", "unvetted"];
export type ClassSums = Record<HolderClass, bigint>;
export const noSums = (): ClassSums => ({ burned: 0n, locked: 0n, withdrawable: 0n, contract: 0n, hook: 0n, swapHook: 0n, venue: 0n, unclassified: 0n, unvetted: 0n });

/** Slopes are kept times 2^128, so a quote amount per unit of square-root price loses nothing that matters. */
const SLOPE_BITS = 128n;

/**
 * One position's token side as buyers meet it: from `lo` (the pool's price, or the range's lower edge when that is
 * higher) to `hi` (the range's upper edge; null for a Uniswap v2 pair, which sells all the way up), it takes
 * `slope * (to - from) >> 128` of quote between two prices. `tokensAbove(q)` is the tokens it still holds once the
 * price has reached `q`. `anchor`: its pool is one where a swap can't be refused or redirected (see `findPath`).
 */
export type Ask = {
  owner: HolderClass;
  lo: bigint;
  hi: bigint | null;
  slope: bigint;
  tokensAbove: (price: bigint) => bigint;
  anchor: boolean;
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
  anchor: boolean;
  scale: bigint;
}): Ask | null {
  if (p.sqrtPriceX96 <= 0n || p.liquidity <= 0n) return null;
  const { quoteIsCurrency0: q0, quoteDecimals: d } = p;
  // The range's two edges as token prices. With the token as currency1 a higher raw price is a lower token price.
  const [rawLow, rawHigh] = [sqrtRatioAtTick(p.tickLower), sqrtRatioAtTick(p.tickUpper)];
  const [edgeLo, edgeHi, rawTop] = q0 ? [tokenSqrtPrice(rawHigh, q0, d), tokenSqrtPrice(rawLow, q0, d), rawLow] : [tokenSqrtPrice(rawLow, q0, d), tokenSqrtPrice(rawHigh, q0, d), rawHigh];
  const now = tokenSqrtPrice(p.sqrtPriceX96, q0, d);
  const lo = now > edgeLo ? now : edgeLo;
  if (edgeHi <= lo) return null;
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
    hi: edgeHi,
    slope: (capacity << SLOPE_BITS) / (edgeHi - lo),
    tokensAbove: (price) => (price <= lo ? tokensAt(p.sqrtPriceX96) : price >= edgeHi ? 0n : tokensAt(rawSqrtPriceAt(price, q0, d))),
    anchor: p.anchor,
  };
}

/**
 * A share of a Uniswap v2 pair as an ask: x * y = k, so the quote reserve grows with the square root of the price, by
 * `reserve / price` per unit of it, for ever, and the token reserve shrinks as `price / q`. `reserve` is the share's
 * quote (scaled), `tokens` its tokens (raw). Null for a pair without tokens or a price.
 */
export function v2Ask(p: { owner: HolderClass; price: bigint; reserve: bigint; tokens: bigint }): Ask | null {
  if (p.price <= 0n || p.tokens <= 0n || p.reserve <= 0n) return null;
  return {
    owner: p.owner,
    lo: p.price,
    hi: null,
    slope: (p.reserve << SLOPE_BITS) / p.price,
    tokensAbove: (q) => (q <= p.price ? p.tokens : (p.tokens * p.price) / q),
    anchor: true,
  };
}

/** The path as the verdict reads it. */
export type AskPath = {
  /** The asks reach `minDepth` of quote: there is a window. Otherwise the whole path is the one prefix, and nothing can pass. */
  reached: boolean;
  /** The price at which `minDepth` has been paid in (P1), and the window's end, twice that price. Null when not reached. */
  p1: bigint | null;
  windowEnd: bigint | null;
  /**
   * The quote paid in, by owner, up to each point checked: P1, every edge inside the window, its end. Two readings of
   * the same points, which differ only in burned or locked liquidity that sits below the path's start in a pool whose
   * hook runs in swaps: `prefixes` leaves it out (it must not water down a wallet's share: what fails and warns),
   * `strict` counts it (it must not go unseen either: what a pass needs).
   */
  prefixes: ClassSums[];
  strict: ClassSums[];
  /** The tokens the window sells, all owners together (raw units). */
  windowTokens: bigint;
  /** The tokens still for sale beyond the window's end, by owner (raw units). Nothing when there is no window. */
  beyond: ClassSums;
};

/**
 * Quote paid into `asks`, by owner, at each of `points` (ascending). Every ask counts from its own first price: a wallet
 * selling below the path's start, in whatever pool, is paid before anyone on the path. Unless `strict`, one kind of ask
 * is left out below `start`: burned or locked liquidity in a pool whose hook runs in swaps ("swapHook"), which may be
 * tokens nobody can buy and would otherwise water down everyone else's share.
 */
function paidAt(asks: readonly Ask[], start: bigint, points: readonly bigint[], strict = true): ClassSums[] {
  // Stops: every point, and every edge at which an ask starts or stops taking money.
  type Event = { at: bigint; owner: HolderClass; slope: bigint };
  const events: Event[] = [];
  const last = points[points.length - 1]!;
  for (const ask of asks) {
    const from = !strict && ask.owner === "swapHook" && ask.lo < start ? start : ask.lo;
    if (from >= last || (ask.hi !== null && ask.hi <= from)) continue;
    events.push({ at: from, owner: ask.owner, slope: ask.slope });
    if (ask.hi !== null && ask.hi < last) events.push({ at: ask.hi, owner: ask.owner, slope: -ask.slope });
  }
  events.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
  const active = noSums();
  const paid = noSums(); // times 2^128
  const out: ClassSums[] = [];
  let at = events.length > 0 && events[0]!.at < start ? events[0]!.at : start;
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
 * - Where it starts and where the window lies come from the anchor asks alone (Uniswap v2 pairs and v4 pools whose hook
 *   has no say in a swap), when there are any: a pool whose hook can refuse or redirect a swap may show tokens nobody
 *   can buy, and must not be able to move the window away from the pools buyers really trade in. With no anchor ask at
 *   all, every ask anchors.
 * - The start is the cheapest price at which an anchor sells. P1 is the price at which the anchors have taken
 *   `minDepth` of quote; the window runs from the start to twice the price at P1.
 * - Shares are then read over EVERY ask up to each point checked: P1, the window's end, and every edge in between. An
 *   ask of a pool that doesn't anchor counts too, from its own first price even when that is below the start (see
 *   `AskPath.prefixes` for the one exception): anchoring decides where the window is, never whose money is left out.
 *   Between two edges the mix is constant (every ask's take is a straight line in the square root of the price), so
 *   those points are the whole truth about every prefix from P1 to the end.
 * - When the anchors never take `minDepth`, there is no window: the whole path is one prefix.
 */
export function findPath(asks: readonly Ask[], minDepth: bigint): AskPath | null {
  if (asks.length === 0) return null;
  const anchors = asks.some((a) => a.anchor) ? asks.filter((a) => a.anchor) : asks;
  const start = anchors.reduce((m, a) => (a.lo < m ? a.lo : m), anchors[0]!.lo);

  // P1: walk the anchors' edges upward, and past the last of them in doublings of the price (a v2 pair sells for ever).
  const edges = new Set<bigint>();
  for (const a of anchors) {
    if (a.lo > start) edges.add(a.lo);
    if (a.hi !== null) edges.add(a.hi);
  }
  let far = [...edges].reduce((m, e) => (e > m ? e : m), start);
  const endless = anchors.some((a) => a.hi === null);
  for (let i = 0; endless && i < 128; i++) edges.add((far = far * 2n));
  const stops = [...edges].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const taken = paidAt(anchors, start, stops).map(total);
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
    return { reached: false, p1: null, windowEnd: null, prefixes: paidAt(asks, start, [top], false), strict: paidAt(asks, start, [top]), windowTokens: 0n, beyond: noSums() };
  }
  const [prev, prevTaken] = reachedAt === 0 ? [start, 0n] : [stops[reachedAt - 1]!, taken[reachedAt - 1]!];
  const [here, hereTaken] = [stops[reachedAt]!, taken[reachedAt]!];
  // Between two edges the anchors' take is a straight line: where on it `minDepth` falls. Rounded up, so that it is reached.
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
  return { reached: true, p1, windowEnd, prefixes: paidAt(asks, start, points, false), strict: paidAt(asks, start, points), windowTokens, beyond };
}
