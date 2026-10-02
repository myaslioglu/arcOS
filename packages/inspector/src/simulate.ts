import { decodeFunctionResult, encodeFunctionData } from "viem";
import { USDC, tradeSimulatorAbi, tradeSimulatorRuntime, type Address } from "@arcos/chain";
import { NATIVE } from "./v4";
import { CallReverted, type ChainReader, type Pool, type PoolKey, type PoolScan } from "./types";

/**
 * Check 10's trade simulation: one `eth_call` that buys the token with USDC from its deepest USDC pool and sells it straight
 * back, run by TradeSimulator (packages/contracts/src/sim) from code placed with a state override. Nothing is sent: no
 * transaction, no key. Only the chain's answer to that one call is read.
 */

/**
 * Where the simulator's code goes for the call, and who the call is from: a throwaway address with no code or state of its
 * own. With `from = to = S`, `tx.origin == msg.sender` inside the simulator, which gets past the common "no contracts"
 * guard. Its overridden native balance is also its USDC ERC-20 balance, on both networks (design F1-F3).
 */
export const SIMULATOR: Address = "0x00000000000000000000000000000000000A4c05";

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

/**
 * The pool to trade against: the deepest that trades USDC, the only currency the override can fund. Depth is what discovery
 * read: v2, v3 and Aerodrome's USDC balance; v4's USDC in range at the current price, a lower figure, so a v4 pool is picked
 * over another kind only when even that is deeper. `null` when there is none.
 */
export function tradePool(scan: PoolScan, token: Address): Pool | null {
  const usable = scan.pools.filter((p) => usdcOf(p, token) !== null);
  return usable.length === 0 ? null : usable.reduce((a, b) => (b.depth > a.depth ? b : a));
}

/** 10 USDC, or 0.1% of the pool's depth when that is less, but never under `MIN_TEST_AMOUNT`. In 6 decimals. */
export function testAmount(pool: Pool): bigint {
  const share = pool.depth / 1000n;
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

/** What the simulator said, in the pool's USDC units (6 decimals, or 18 for native USDC on v4). */
export type SimulatorResult = { status: number; spent: bigint; bought: bigint; sold: bigint; received: bigint };

export type TradeRun =
  | { kind: "no-pool" }
  /** The call reverted or ran out of its gas: the node's answer, but none about the token. */
  | { kind: "call-reverted"; pool: Pool; amount: bigint }
  /** The node ran no code (it ignored the override), or answered something that isn't the simulator's result. */
  | { kind: "no-answer"; pool: Pool; amount: bigint }
  /** The node refused the call, or the endpoint failed. */
  | { kind: "call-failed"; pool: Pool; amount: bigint }
  | { kind: "ran"; pool: Pool; amount: bigint; decimals: 6 | 18; result: SimulatorResult };

/**
 * Runs the round trip against the deepest USDC pool. One eth_call, gas-capped; nothing else is read. Every failure is
 * returned as what it is, for the check to read as `unknown`; a rejection never escapes.
 */
export async function simulateTrade(reader: ChainReader, token: Address, scan: PoolScan): Promise<TradeRun> {
  const pool = tradePool(scan, token);
  if (!pool) return { kind: "no-pool" };
  const amount = testAmount(pool);
  const usdc = usdcOf(pool, token)!;
  const native = lower(usdc) === lower(NATIVE);
  const decimals = native ? 18 : 6;
  const trade = {
    kind: KIND[pool.version],
    pool: pool.address,
    token,
    usdc,
    amount: native ? amount * 10n ** 12n : amount,
    key: pool.version === "v4" ? pool.key! : NO_KEY,
  };
  let answer: `0x${string}`;
  try {
    answer = await reader.callWithOverride(
      { from: SIMULATOR, to: SIMULATOR, data: encodeFunctionData({ abi: tradeSimulatorAbi, functionName: "simulate", args: [trade] }), gas: TRADE_GAS },
      // One balance, two views: this is `amount` USDC in the ERC-20's 6 decimals and in native's 18 alike.
      [{ address: SIMULATOR, code: tradeSimulatorRuntime, balance: amount * 10n ** 12n }],
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
