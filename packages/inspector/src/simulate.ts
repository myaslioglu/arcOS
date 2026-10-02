import { decodeFunctionResult, encodeFunctionData, getAddress } from "viem";
import { USDC, tradeSimulatorAbi, tradeSimulatorRuntime, type Address } from "@arcos/chain";
import { NATIVE } from "./v4";
import { CallReverted, type ChainReader, type Pool, type PoolKey, type PoolScan } from "./types";

/**
 * Check 10's trade simulation: one `eth_call` that buys the token with USDC from its deepest USDC pool and sells it straight
 * back, run by TradeSimulator (packages/contracts/src/sim) from code placed with a state override. Nothing is sent: no
 * transaction, no key. Only the chain's answer to that one call is read.
 */

/**
 * Where the simulator's code goes for the call (S), and where its second copy, the router that moves the token on a sell,
 * goes (R): two fresh random addresses for every call, so a token can't recognise a fixed one. The call is from S to S, so
 * `tx.origin == msg.sender` inside the simulator, which gets past the common "no contracts" guard. S's overridden native
 * balance is also its USDC ERC-20 balance, on both networks (design F1-F3).
 */
export type SimulatorAddresses = { simulator: Address; router: Address };

/**
 * Whether a random address can stand in for an ordinary account: fewer than four zero bytes. Precompiles, Arc's system
 * contracts (USDC at 0x3600…0000 among them) and other low or reserved addresses are mostly zero bytes; a random address
 * has four or more about once in a million draws, and is drawn again.
 */
export function isOrdinaryAddress(address: Address): boolean {
  const hex = address.slice(2);
  let zeros = 0;
  for (let i = 0; i < 40; i += 2) if (hex.slice(i, i + 2) === "00") zeros++;
  return hex.length === 40 && zeros < 4;
}

/** How many draws an address gets before giving up: a working random source needs one, almost always. */
const MAX_DRAWS = 100;

/**
 * 20 random bytes as a checksummed address, drawn again until `isOrdinaryAddress` accepts it. Throws after `MAX_DRAWS` draws,
 * so a source that keeps giving the same bytes can't loop forever.
 */
export function randomAddress(fill: (bytes: Uint8Array) => void = (b) => crypto.getRandomValues(b)): Address {
  for (let draw = 0; draw < MAX_DRAWS; draw++) {
    const bytes = new Uint8Array(20);
    fill(bytes);
    const address = `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}` as Address;
    if (isOrdinaryAddress(address)) return getAddress(address);
  }
  throw new Error("the random source gave no usable address");
}

/** A fresh S and R, never the same address. Throws, as `randomAddress` does, after `MAX_DRAWS` draws for R. */
export function simulatorAddresses(fill?: (bytes: Uint8Array) => void): SimulatorAddresses {
  const simulator = randomAddress(fill);
  for (let draw = 0; draw < MAX_DRAWS; draw++) {
    const router = randomAddress(fill);
    if (lower(router) !== lower(simulator)) return { simulator, router };
  }
  throw new Error("the random source gave no second address");
}

/**
 * The gas the whole round trip may use. An honest buy and sell is a few hundred thousand; a token that runs a swap of its
 * own on every sell (a tax sold for USDC as it is taken) about a million. 5M leaves room for that and keeps a token that
 * burns gas far below the ~30M an eth_call gets. The simulator splits it between the two legs and reports a leg that used
 * up its share as out of gas, which is never read as the token's answer.
 */
export const TRADE_GAS = 5_000_000n;

/** At most 10 USDC (6 decimals) goes in. */
export const MAX_TEST_AMOUNT = 10_000_000n;
/**
 * At least 0.01 USDC goes in, however thin the pool looks. Below that a pool's rounding alone can be a large part of the
 * result. And a v4 pool's depth is only the USDC in range at the current price, which for a fresh launch pool (all of its
 * liquidity on the token's side) is about nothing although a buy is served in full; the trade answers for itself there:
 * a buy that can't be served reverts, or spends nothing, and either is `unknown`.
 */
export const MIN_TEST_AMOUNT = 10_000n;

/** The kinds TradeSimulator swaps through: a v2 pair, a v3-style pool (Uniswap v3 and Aerodrome Slipstream), v4's PoolManager. */
const KIND = { v2: 0, v3: 1, aero: 1, v4: 2 } as const;

/** TradeSimulator's statuses. */
export const STATUS = { ok: 0, buyReverted: 1, buyOutOfGas: 2, sellReverted: 3, sellOutOfGas: 4, poolCantTrade: 5, amountOverLimit: 6 } as const;

/** One part in a million: fees are counted in these, as Uniswap counts them (3000 is 0.3%). */
const PPM = 1_000_000n;
/** v4's flag for a pool whose fee its hook sets on every swap. */
const DYNAMIC_FEE_FLAG = 0x800000;

const lower = (a: string) => a.toLowerCase();
const NO_KEY: PoolKey = { currency0: NATIVE, currency1: NATIVE, fee: 0, tickSpacing: 0, hooks: NATIVE };

/** Which USDC a pool trades: the ERC-20 at 0x3600 for v2, v3 and Aerodrome; for v4, whichever of its currencies isn't the token. */
function usdcOf(pool: Pool, token: Address): Address | null {
  if (pool.version !== "v4") return pool.quote === "USDC" ? USDC : null;
  if (!pool.key) return null;
  const other = lower(pool.key.currency0) === lower(token) ? pool.key.currency1 : pool.key.currency0;
  return lower(other) === lower(USDC) || lower(other) === lower(NATIVE) ? other : null;
}

/** A v4 pool with a hook, which runs inside every swap. */
const hooked = (pool: Pool): boolean => pool.version === "v4" && pool.key !== undefined && BigInt(pool.key.hooks) !== 0n;

/** 1,000 USDC (6 decimals): what a pool must be able to pay out to count as liquid. */
export const MIN_DEPTH = 1_000_000_000n;

/**
 * The depth the trade check orders and compares pools by: `depth`, except that a v4 pool found liquid counts as at least
 * `MIN_DEPTH`. A v4 pool's depth is only what is in range at the current price, which can be near 0 in a pool whose quote
 * paid out 1,000 USDC, so it would otherwise come after a thin pair. EURC is compared 1:1 with USDC.
 */
export function orderDepth(pool: Pool): bigint {
  return pool.version === "v4" && pool.liquid === true && pool.depth < MIN_DEPTH ? MIN_DEPTH : pool.depth;
}

/** The deepest of `pools` (by `orderDepth`), or `null` when there is none. */
const deepest = (pools: Pool[]): Pool | null =>
  pools.length === 0 ? null : pools.reduce((a, b) => (orderDepth(b) > orderDepth(a) ? b : a));

/** `pools`, deepest first (by `orderDepth`). */
const byDepth = (pools: Pool[]): Pool[] =>
  [...pools].sort((a, b) => {
    const [da, db] = [orderDepth(a), orderDepth(b)];
    return db > da ? 1 : db < da ? -1 : 0;
  });

/**
 * The most pools a round trip is run in, liquid ones first, each its own eth_call (and a second one when its sell is
 * refused): at most 12 eth_calls.
 */
export const MAX_POOLS = 6;

/** The trade check's time when the caller gave it no deadline: its gas price read and every pool's round trips in it. */
export const DEFAULT_TRADE_MS = 8_000;

/** Kept back from the inspection's deadline for the rest of the report, so the trade check ends before the caller stops waiting. */
export const DEADLINE_MARGIN_MS = 1_000;

/**
 * The most USDC a buy of one raw unit may take in a pair that quotes nothing for the test amount: the larger of 20 USDC and
 * 2% of the pair's USDC reserve, but never over 1,000 USDC (6 decimals). The override funds S with it, so it costs nothing.
 */
export const MIN_UNIT_BUY = 20_000_000n;
export const MAX_UNIT_BUY = 1_000_000_000n;
export const unitBuyLimit = (depth: bigint): bigint => {
  const share = (depth * 2n) / 100n;
  return share > MAX_UNIT_BUY ? MAX_UNIT_BUY : share < MIN_UNIT_BUY ? MIN_UNIT_BUY : share;
};

/**
 * The pools to trade against, in the order they are tried: those that trade USDC, the only currency the override can fund,
 * deepest first, every pool without a hook before any with one. Depth is what discovery read: v3 and Aerodrome's USDC
 * balance; v4's USDC in range at the current price, a lower figure, so a v4 pool comes before another kind only when even
 * that is deeper; a v2 pair's USDC reserve. A v2 pair with no tokens in its reserves (`tradable: false`: USDC `sync`ed in
 * and nothing else) is left out. Depth still doesn't prove a pool trades: USDC sent to a v3 or Aerodrome pool with no
 * liquidity raises its balance, so every liquid pool is measured, not only the deepest (`simulateTrade`).
 */
export function tradePools(scan: PoolScan, token: Address): Pool[] {
  const usable = scan.pools.filter((p) => usdcOf(p, token) !== null && p.tradable !== false);
  return [...byDepth(usable.filter((p) => !hooked(p))), ...byDepth(usable.filter(hooked))];
}

/** The first pool `tradePools` would try, or `null` when there is none. */
export function tradePool(scan: PoolScan, token: Address): Pool | null {
  return tradePools(scan, token)[0] ?? null;
}

/**
 * Whether a round trip's buy couldn't trade: it reverted, took no USDC, or the pool paid nothing out. That says something
 * about the pool, not about selling the token.
 */
export function buyDidNotTrade(attempt: TradeAttempt): boolean {
  if (attempt.kind !== "ran") return false;
  const r = attempt.result;
  return (
    r.status === STATUS.buyReverted ||
    r.status === STATUS.poolCantTrade ||
    r.status === STATUS.amountOverLimit ||
    (r.status === STATUS.ok && (r.spent === 0n || (r.paidOut === 0n && r.bought === 0n)))
  );
}

/**
 * Whether a round trip's buy couldn't trade on the pool's account alone, which nothing the token does can bring about: the
 * simulator found the pool can't serve the buy before sending anything (`poolCantTrade`: a v2 pair whose reserves give
 * nothing, a pool with no price or its price at the limit), or the pool took nothing and paid nothing out. Only such a
 * pool may be left out of the finding. Everything else may be the token's doing and counts: a buy that reverted; one
 * that took USDC and paid nothing out (a buy too small for one raw unit of a token with few decimals rounds to nothing);
 * one that took no USDC though the pool paid out (a refund); a buy one raw unit of costs more than the limit.
 */
export function poolCouldNotTrade(attempt: TradeAttempt): boolean {
  if (attempt.kind !== "ran") return false;
  const r = attempt.result;
  return r.status === STATUS.poolCantTrade || (r.status === STATUS.ok && r.spent === 0n && r.paidOut === 0n);
}

/**
 * Whether a sell into `pool` can revert on the pool's account rather than the token's: a Uniswap v3 or Aerodrome pool checks
 * it was paid in full, so it refuses a token that arrives short (a transfer tax), and a v4 pool's hook runs inside the swap
 * and can refuse it. A Uniswap v2 pair or a hookless v4 pool takes what arrived.
 */
export function poolCanRefuseSell(pool: Pool): boolean {
  return pool.version === "v3" || pool.version === "aero" || hooked(pool);
}

/**
 * Where a sell refused by `refused` is tried again: the deepest Uniswap v2 or hookless v4 USDC pool that can actually trade,
 * one discovery found liquid (for a v2 pair: 1,000 USDC and some tokens in its reserves, and a nonzero quote for its test
 * amount; for v4: a quote paid out) and whose depth covers `testAmount(refused)`, the amount the refused round trip traded.
 * Anyone can create an empty pair or pool for nothing, and its failed buy must not stand in for a sell that went through.
 * `exclude` are pools already found not to trade. `null` when there is none.
 */
export function fallbackPool(scan: PoolScan, token: Address, refused: Pool, exclude: readonly Pool[] = []): Pool | null {
  const amount = testAmount(refused);
  return deepest(
    scan.pools.filter(
      (p) =>
        p !== refused &&
        !exclude.includes(p) &&
        usdcOf(p, token) !== null &&
        !poolCanRefuseSell(p) &&
        p.liquid === true &&
        orderDepth(p) >= amount,
    ),
  );
}

/** 10 USDC, or 0.1% of the pool's depth when that is less, but never under `MIN_TEST_AMOUNT`. In 6 decimals. */
export function testAmount(pool: Pool): bigint {
  return testAmountFor(pool.depth);
}

/** What a v2 pair pays out, at its 0.3% fee, for `amountIn`. */
export const v2Out = (amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint =>
  amountIn === 0n ? 0n : (amountIn * 997n * reserveOut) / (reserveIn * 1000n + amountIn * 997n);

/**
 * What the round trip in `pool` buys with: `testAmount`, except in a v2 pair that pays nothing for it (a dust raw reserve,
 * or a token whose one raw unit is worth more), where it is what buys one raw unit, if that is at most `unitBuyLimit`.
 * `null` when no such amount exists: a buy there can't trade, and the pool isn't tried.
 */
export function tradeAmount(pool: Pool): bigint | null {
  const amount = testAmount(pool);
  if (pool.version !== "v2" || pool.tokenReserve === undefined) return amount;
  if (v2Out(amount, pool.depth, pool.tokenReserve) > 0n) return amount;
  if (pool.tokenReserve <= 1n) return null;
  const one = (pool.depth * 1000n) / ((pool.tokenReserve - 1n) * 997n) + 1n;
  return one > unitBuyLimit(pool.depth) ? null : one < MIN_TEST_AMOUNT ? MIN_TEST_AMOUNT : one;
}

/** `testAmount` for a pool `depth` deep. */
export function testAmountFor(depth: bigint): bigint {
  const share = depth / 1000n;
  return share > MAX_TEST_AMOUNT ? MAX_TEST_AMOUNT : share < MIN_TEST_AMOUNT ? MIN_TEST_AMOUNT : share;
}

/**
 * What the pool charges on a round trip, in ppm, or `null` when it can change from one swap to the next: a v4 pool with a
 * hook (which runs inside every swap) or a dynamic fee, and Aerodrome, whose fee module can set a pool's fee. Two swaps each
 * keep `fee` of what goes in: 1 - (1 - fee)^2.
 */
export function roundTripFee(pool: Pool): bigint | null {
  const fee =
    pool.version === "v2" ? 3000
    : pool.version === "v3" ? pool.fee
    : pool.version === "v4" && pool.key && BigInt(pool.key.hooks) === 0n && pool.key.fee !== DYNAMIC_FEE_FLAG ? pool.key.fee
    : undefined;
  if (fee === undefined) return null;
  const kept = PPM - BigInt(fee);
  return PPM - (kept * kept) / PPM;
}

/**
 * What the simulator said, in the pool's USDC units (6 decimals, or 18 for native USDC on v4) for `spent` and `received`.
 * `paidOut` is what the pool paid out on the buy, in token units, next to `bought`, what arrived.
 */
export type SimulatorResult = { status: number; spent: bigint; paidOut: bigint; bought: bigint; sold: bigint; received: bigint };

/** One round trip against one pool. */
export type TradeAttempt =
  /** It didn't finish by the trade check's deadline (see `simulateTrade`). */
  | { kind: "timed-out"; pool: Pool; amount: bigint }
  /** The call reverted or ran out of its gas: the node's answer, but none about the token. */
  | { kind: "call-reverted"; pool: Pool; amount: bigint }
  /** The node ran no code (it ignored the override), or answered something that isn't the simulator's result. */
  | { kind: "no-answer"; pool: Pool; amount: bigint }
  /** The node refused the call, or the endpoint failed (the gas price read included). */
  | { kind: "call-failed"; pool: Pool; amount: bigint }
  /**
   * The simulator ran. `second` is the round trip tried on the deepest Uniswap v2 or hookless v4 USDC pool after the sell
   * reverted in a pool that can refuse one on its own account (`poolCanRefuseSell`); absent when that wasn't needed or there
   * is no such pool.
   */
  | { kind: "ran"; pool: Pool; amount: bigint; decimals: 6 | 18; result: SimulatorResult; second?: TradeAttempt };

/**
 * What `simulateTrade` measured. `attempts` are the round trips, one per pool tried (`tradeCandidates`, up to `MAX_POOLS`),
 * in order. `candidates` is how many pools it would have tried without that cap.
 */
export type TradeRun = { kind: "no-pool" } | { kind: "measured"; attempts: TradeAttempt[]; candidates: number };

/**
 * The pools a round trip is run in, in order: every USDC pool without a hook that discovery found liquid, by `orderDepth`;
 * then every one it didn't that could still be where the token trades, by depth: a v2 pair with tokens in its reserves
 * and a `tradeAmount`, a v3 or Aerodrome pool holding any USDC, and any hookless v4 pool that exists (a single-sided launch
 * pool has no USDC in range and a quote that can't pay, yet sells into it). A liquid decoy then can't hide a thinner real
 * pool. When there is none of those, the deepest pool `tradePools` gives, hooked or not.
 */
export function tradeCandidates(scan: PoolScan, token: Address): Pool[] {
  const all = tradePools(scan, token);
  const hookless = all.filter((p) => !hooked(p));
  const liquid = hookless.filter((p) => p.liquid === true);
  const thin = hookless
    .filter((p) => p.liquid !== true && (p.version === "v4" || p.depth > 0n || (p.tokenReserve ?? 0n) > 0n) && tradeAmount(p) !== null)
    .sort((x, y) => (y.depth > x.depth ? 1 : y.depth < x.depth ? -1 : 0));
  const candidates = [...liquid, ...thin];
  return candidates.length > 0 ? candidates : all.slice(0, 1);
}

/**
 * Runs the round trips: one in each of the first `MAX_POOLS` of `tradeCandidates`, each its own eth_call from fresh S and R
 * addresses, in parallel, at the network's gas price. When a sell reverts in a pool that can refuse a sell on its own
 * account, that pool's round trip is tried again in the deepest liquid Uniswap v2 or hookless v4 USDC pool, if there is
 * one. The gas price read and every pool's round trips must end by `deadlineAt` (ms since the epoch, the inspection's
 * deadline less `DEADLINE_MARGIN_MS`), or within `DEFAULT_TRADE_MS` without one: a gas price read that doesn't is
 * `call-failed` for every pool, a pool whose round trips don't is `timed-out`. Nothing else is read. Every failure is
 * returned as what it is; a rejection never escapes.
 *
 * At most: one eth_gasPrice and 2 * `MAX_POOLS` eth_calls (12).
 */
export async function simulateTrade(reader: ChainReader, token: Address, scan: PoolScan, deadlineAt?: number): Promise<TradeRun> {
  const candidates = tradeCandidates(scan, token);
  if (candidates.length === 0) return { kind: "no-pool" };
  const pools = candidates.slice(0, MAX_POOLS);
  // A v2 pair with tokens where no amount within `unitBuyLimit` buys anything isn't tried, but it is still a pool the
  // token could trade in, so it counts among the candidates and caps a pass as any pool left untried does.
  const unbuyable = tradePools(scan, token).filter(
    (p) => !hooked(p) && p.version === "v2" && (p.tokenReserve ?? 0n) > 0n && tradeAmount(p) === null && !candidates.includes(p),
  ).length;
  const end = deadlineAt === undefined ? Date.now() + DEFAULT_TRADE_MS : deadlineAt - DEADLINE_MARGIN_MS;
  const failed = (kind: "call-failed" | "timed-out"): TradeRun => ({
    kind: "measured",
    attempts: pools.map((pool) => ({ kind, pool, amount: tradeAmount(pool) ?? testAmount(pool) })),
    candidates: candidates.length + unbuyable,
  });
  if (end <= Date.now()) return failed("timed-out");
  let gasPrice: bigint;
  try {
    gasPrice = await within(reader.gasPrice(), end);
  } catch {
    return failed("call-failed");
  }
  const attempts = await Promise.all(pools.map((pool) => withPoolDeadline(pool, poolRoundTrips(reader, token, scan, pool, gasPrice), end)));
  return { kind: "measured", attempts, candidates: candidates.length + unbuyable };
}

/** `p`, or a rejection once `end` (ms since the epoch) has passed. */
function within<T>(p: Promise<T>, end: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("deadline")), Math.max(0, end - Date.now()));
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e as Error);
      },
    );
  });
}

/** A pool's round trip, and the retry in another pool when its sell was refused there. */
async function poolRoundTrips(reader: ChainReader, token: Address, scan: PoolScan, pool: Pool, gasPrice: bigint): Promise<TradeAttempt> {
  const first = await roundTrip(reader, token, pool, gasPrice);
  if (first.kind !== "ran" || first.result.status !== STATUS.sellReverted || !poolCanRefuseSell(pool)) return first;
  const other = fallbackPool(scan, token, pool);
  return other ? { ...first, second: await roundTrip(reader, token, other, gasPrice) } : first;
}

/** `attempt`, or `timed-out` for `pool` once `end` (ms since the epoch) has passed. */
function withPoolDeadline(pool: Pool, attempt: Promise<TradeAttempt>, end: number): Promise<TradeAttempt> {
  const amount = tradeAmount(pool) ?? testAmount(pool);
  return within(attempt, end).catch((e: unknown) =>
    e instanceof Error && e.message === "deadline" ? { kind: "timed-out" as const, pool, amount } : { kind: "call-failed" as const, pool, amount },
  );
}

/**
 * One round trip against `pool`, from a fresh S with a fresh router R, at `gasPrice`. The call's gas is prepaid from S's
 * balance before anything runs, so S is funded with the test amount plus `TRADE_GAS * gasPrice`; the legs measure balance
 * changes, so what is prepaid never shows in the result.
 */
async function roundTrip(reader: ChainReader, token: Address, pool: Pool, gasPrice: bigint): Promise<TradeAttempt> {
  const amount = tradeAmount(pool) ?? testAmount(pool);
  // A v3, Slipstream or v4 buy may be raised, in the simulator, to buy whole raw units of a token with few decimals, up to
  // `unitBuyLimit`; S is funded for that. A v2 buy is sized here (`tradeAmount`).
  const limit = unitBuyLimit(pool.depth);
  const maxAmount = pool.version === "v2" || limit < amount ? amount : limit;
  const usdc = usdcOf(pool, token)!;
  const native = lower(usdc) === lower(NATIVE);
  const decimals = native ? 18 : 6;
  const { simulator, router } = simulatorAddresses();
  const trade = {
    kind: KIND[pool.version],
    pool: pool.address,
    token,
    usdc,
    router,
    amount: native ? amount * 10n ** 12n : amount,
    maxAmount: native ? maxAmount * 10n ** 12n : maxAmount,
    key: pool.version === "v4" ? pool.key! : NO_KEY,
  };
  let answer: `0x${string}`;
  try {
    answer = await reader.callWithOverride(
      {
        from: simulator,
        to: simulator,
        data: encodeFunctionData({ abi: tradeSimulatorAbi, functionName: "simulate", args: [trade] }),
        gas: TRADE_GAS,
        gasPrice,
      },
      // One balance, two views: past the prepaid gas, this is `amount` USDC in the ERC-20's 6 decimals and in native's 18
      // alike. R needs only the code.
      [
        { address: simulator, code: tradeSimulatorRuntime, balance: maxAmount * 10n ** 12n + TRADE_GAS * gasPrice },
        { address: router, code: tradeSimulatorRuntime },
      ],
    );
  } catch (e) {
    return e instanceof CallReverted ? { kind: "call-reverted", pool, amount } : { kind: "call-failed", pool, amount };
  }
  try {
    const result = decodeFunctionResult({ abi: tradeSimulatorAbi, functionName: "simulate", data: answer }) as SimulatorResult;
    return { kind: "ran", pool, amount, decimals, result: { ...result, status: Number(result.status) } };
  } catch {
    return { kind: "no-answer", pool, amount };
  }
}
