import { formatUnits } from "viem";
import { formatUsdc, type Address } from "@arcos/chain";
import type { FailedRow } from "./result";

/**
 * CSV text (`address,amount` per line) for the rows a Drop failed to deliver, so the user can paste it
 * back into the list and retry just those. `token === null` means the batch was sent as native USDC: the
 * failure event's amount comes back as native wei (18 decimals), the same value `unitsToNative` produced
 * from what the user typed in 6-decimal units, so `formatUsdc` is the matching formatter — it round-trips
 * exactly back to the typed amount. A real ERC-20 batch carries the amount in the token's own decimals.
 */
export function failedRowsText(rows: FailedRow[], token: Address | null, decimals: number): string {
  return rows.map((r) => `${r.address},${token ? formatUnits(r.amount, decimals) : formatUsdc(r.amount)}`).join("\n");
}
