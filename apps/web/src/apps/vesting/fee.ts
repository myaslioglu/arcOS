import { displayWei } from "@/lib/display-amount";

/** The fee for `rows` schedules: VEST_FLAT (native USDC, 18 decimals) once per schedule, charged by each createVesting call. */
export function vestFeeTotal(fee: bigint, rows: number): bigint {
  return fee * BigInt(Math.max(0, rows));
}

/**
 * The fee line shown before signing. `fee` is null while it is being read and "error" when the read failed. Rounded up,
 * so what the person pays is never understated.
 */
export function vestFeeText(fee: bigint | "error" | null, rows: number): string {
  if (rows <= 0) return "";
  if (fee === "error") return "";
  if (fee === null) return "Reading the fee…";
  const each = displayWei(fee, "up");
  if (rows === 1) return `Fee ${each} USDC · paid in USDC with the transaction`;
  return `Fee ${displayWei(vestFeeTotal(fee, rows), "up")} USDC · ${each} USDC for each of ${rows} schedules, charged as each one is created`;
}
