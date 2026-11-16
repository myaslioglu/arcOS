import { formatUnits } from "viem";
import type { DropRow } from "@/lib/recipient-list";

/** Rows back as `address,amount` lines, with no thousands separators: the text re-reads to the same amounts. */
export function rowsText(rows: readonly DropRow[], decimals: number): string {
  return rows.map((r) => `${r.address},${formatUnits(r.amount, decimals)}`).join("\n");
}
