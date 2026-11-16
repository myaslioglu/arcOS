import type { Hex } from "viem";
import { displayUnits, displayWei } from "@/lib/display-amount";
import { lpSplit } from "./lockForm";

/**
 * What a lock costs, read from the chain: the VaultFactory's own FeeController (`feeController()`, immutable in the
 * factory), never a network's configured one, so the app shows what the factory will charge.
 * - `flat`: LOCK_FLAT, native USDC (18 decimals) sent as the lock call's value, per lock.
 * - `lpBps`: LOCK_LP_BPS, the share of a Uniswap v2 LP token lock that goes to ArcOS (lpSplit).
 * - `shareBps`: LOCK_FEE_SHARE_BPS, ArcOS's share of the trading fees a position vault collects, copied into the vault
 *   when it is made, so a later change never reaches an existing lock.
 */
export type LockFees = { feeController: `0x${string}`; flat: bigint; lpBps: bigint; shareBps: bigint };

/** The three calls VaultFactory._isV2Pair makes, by selector. */
export const V2_PAIR_CALLS = {
  token0: "0x0dfe1681",
  token1: "0xd21220a7",
  getReserves: "0x0902f1ac",
} as const satisfies Record<string, Hex>;

/** One raw call's answer: its return data ("0x" or undefined for none), or null when it reverted. */
export type RawAnswer = Hex | undefined | null;

const bytes = (answer: RawAnswer): number => (answer === null ? -1 : answer === undefined ? 0 : (answer.length - 2) / 2);

/**
 * VaultFactory._isV2Pair, exactly: `token0()`, `token1()` and `getReserves()` all succeed and return exactly 32, 32
 * and 96 bytes. Detection is by shape only, as in the contract: a token shaped like a pair pays the LP share there, so
 * the form says so whenever the contract will charge it.
 */
export function isV2PairShape(token0: RawAnswer, token1: RawAnswer, reserves: RawAnswer): boolean {
  return bytes(token0) === 32 && bytes(token1) === 32 && bytes(reserves) === 96;
}

/** Basis points as a percentage: 50 is "0.5%", 200 is "2%". */
export function bpsText(bps: bigint): string {
  const whole = bps / 100n;
  const frac = (bps % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}%` : `${whole}%`;
}

/** "Fee: 30 USDC per lock, sent with the lock transaction, plus gas." */
export function flatFeeLine(flat: bigint): string {
  return `Fee: ${displayWei(flat, "up")} USDC per lock, sent with the lock transaction, plus gas.`;
}

/**
 * The LP share's line, for an amount or before one is typed. The vault receives the amount less the share (rounded
 * down, so ArcOS never takes more than the stated share).
 */
export function lpFeeLine(bps: bigint, amount: bigint | null, decimals: number, symbol: string): string {
  const share = `This is a Uniswap v2 LP token, so ${bpsText(bps)} of the amount goes to ArcOS`;
  if (amount === null || amount === 0n) return `${share} and the vault receives the rest.`;
  const { toVault } = lpSplit(amount, bps);
  return `${share}: the vault receives ${displayUnits(toVault, decimals, "down")} of your ${displayUnits(amount, decimals, "down")} ${symbol}.`;
}

/** The position share's line. The position's principal is never charged; only the fees collected from the vault are. */
export function shareFeeLine(bps: bigint): string {
  return `ArcOS keeps ${bpsText(bps)} of the trading fees you collect from the vault. The position itself is not charged.`;
}
