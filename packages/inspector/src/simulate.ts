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
export const STATUS = { ok: 0, buyReverted: 1, buyOutOfGas: 2, sellReverted: 3, sellOutOfGas: 4 } as const;

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

/** The most liquid pools a round trip is run in, each its own eth_call (and a second one when its sell is refused). */
export const MAX_LIQUID_POOLS = 4;

/** How long one pool's round trip (with its retry) may take before it counts as unanswered: `unknown` for that pool. */
export const POOL_DEADLINE_MS = 8_000;

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
  return r.status === STATUS.buyReverted || (r.status === STATUS.ok && (r.spent === 0n || (r.paidOut === 0n && r.bought === 0n)));
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
  /** It didn't finish within `POOL_DEADLINE_MS`. */
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
 * What `simulateTrade` measured. `attempts` are the round trips, one per pool, in the order of `tradePools`: one in every
 * liquid USDC pool without a hook, up to `MAX_LIQUID_POOLS`; or, when there is no liquid one, a single one in the deepest
 * pool it can trade against. `liquidCount` is how many liquid USDC pools without a hook there are, tried or not.
 */
export type TradeRun = { kind: "no-pool" } | { kind: "measured"; attempts: TradeAttempt[]; liquidCount: number };

/**
 * Runs the round trips: one in every USDC pool discovery found liquid (none has a hook: a hooked pool is never found
 * liquid), up to `MAX_LIQUID_POOLS`, each its own eth_call from fresh S and R addresses, in parallel, at the network's gas
 * price; or, when there is no liquid pool, one in the deepest pool it can trade against. When a sell reverts in a pool that
 * can refuse a sell on its own account, that pool's round trip is tried again in the deepest Uniswap v2 or hookless v4 USDC
 * pool that can trade, if there is one. Each pool's round trips are given `POOL_DEADLINE_MS`; one that takes longer is
 * `timed-out`. Nothing else is read. Every failure is returned as what it is; a rejection never escapes.
 *
 * At most: one eth_gasPrice and 2 * `MAX_LIQUID_POOLS` eth_calls (8).
 */
export async function simulateTrade(reader: ChainReader, token: Address, scan: PoolScan): Promise<TradeRun> {
  const all = tradePools(scan, token);
  if (all.length === 0) return { kind: "no-pool" };
  const liquid = all.filter((p) => p.liquid === true && !hooked(p));
  const pools = liquid.length > 0 ? liquid.slice(0, MAX_LIQUID_POOLS) : [all[0]!];
  let gasPrice: bigint;
  try {
    gasPrice = await reader.gasPrice();
  } catch {
    return { kind: "measured", attempts: pools.map((pool) => ({ kind: "call-failed", pool, amount: testAmount(pool) })), liquidCount: liquid.length };
  }
  const attempts = await Promise.all(pools.map((pool) => withPoolDeadline(pool, poolRoundTrips(reader, token, scan, pool, gasPrice))));
  return { kind: "measured", attempts, liquidCount: liquid.length };
}

/** A pool's round trip, and the retry in another pool when its sell was refused there. */
async function poolRoundTrips(reader: ChainReader, token: Address, scan: PoolScan, pool: Pool, gasPrice: bigint): Promise<TradeAttempt> {
  const first = await roundTrip(reader, token, pool, gasPrice);
  if (first.kind !== "ran" || first.result.status !== STATUS.sellReverted || !poolCanRefuseSell(pool)) return first;
  const other = fallbackPool(scan, token, pool);
  return other ? { ...first, second: await roundTrip(reader, token, other, gasPrice) } : first;
}

/** `attempt`, or `timed-out` for `pool` once `POOL_DEADLINE_MS` has passed. */
function withPoolDeadline(pool: Pool, attempt: Promise<TradeAttempt>): Promise<TradeAttempt> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: "timed-out", pool, amount: testAmount(pool) }), POOL_DEADLINE_MS);
    attempt.then(
      (a) => {
        clearTimeout(timer);
        resolve(a);
      },
      () => {
        clearTimeout(timer);
        resolve({ kind: "call-failed", pool, amount: testAmount(pool) });
      },
    );
  });
}

/**
 * One round trip against `pool`, from a fresh S with a fresh router R, at `gasPrice`. The call's gas is prepaid from S's
 * balance before anything runs, so S is funded with the test amount plus `TRADE_GAS * gasPrice`; the legs measure balance
 * changes, so what is prepaid never shows in the result.
 */
async function roundTrip(reader: ChainReader, token: Address, pool: Pool, gasPrice: bigint): Promise<TradeAttempt> {
  const amount = testAmount(pool);
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
        { address: simulator, code: tradeSimulatorRuntime, balance: amount * 10n ** 12n + TRADE_GAS * gasPrice },
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
