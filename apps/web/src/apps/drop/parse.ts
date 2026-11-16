import { formatUnits } from "viem";
import { formatUsdc, unitsToNative, type Address } from "@arcos/chain";
import type { DropRow } from "@/lib/recipient-list";

export {
  MAX_ROWS,
  ambiguousBannerText,
  hasAmbiguousIssue,
  parseDropList,
  type DropIssue,
  type DropRow,
} from "@/lib/recipient-list";

/**
 * Recipients per transaction. Measured in Foundry against Arc's 30,000,000 block gas limit:
 * 400 fresh native recipients cost roughly 14.1M gas inside the call, 400 fresh ERC-20
 * recipients roughly 10.9M, plus ~0.3-0.4M of calldata/intrinsic gas — matching
 * Multisend.MAX_RECIPIENTS (also 400). BATCH is kept well under that ceiling, at about a
 * quarter of the block, so a batch leaves headroom for the rest of the block's other
 * transactions. Testnet gas usage for a real batch is still worth confirming (see the R0 report).
 */
export const BATCH = 200;

/** Mirrors Multisend.MAX_RECIPIENTS — the hard cap the contract enforces per call. */
export const MAX_BATCH = 400;

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The size of each batch `count` items would split into at `size` per batch — the same numbers
 * `chunk(...).map(b => b.length)` would produce, computed arithmetically instead of by building a
 * `count`-length array just to measure it (useful when `count` is a quote, not a real row list).
 */
export function batchSizes(count: number, size: number): number[] {
  const sizes: number[] = [];
  let remaining = count;
  while (remaining > 0) {
    const n = Math.min(remaining, size);
    sizes.push(n);
    remaining -= n;
  }
  return sizes;
}

/**
 * The exact inverse of `parseDropList`: turns rows back into `address,amount` list text, one row per line,
 * with no thousands separators, so the result re-parses to the same amounts. `row.amount` is in the same
 * units `parseDropList` produced it in — 6-decimal USDC units for native mode (`token === null`), so it
 * needs `unitsToNative` before `formatUsdc` (which expects native wei); a real token's units already match
 * its own `decimals`, so `formatUnits` applies directly.
 */
export function formatDropList(rows: DropRow[], token: Address | null, decimals: number): string {
  return rows.map((r) => `${r.address},${token ? formatUnits(r.amount, decimals) : formatUsdc(unitsToNative(r.amount))}`).join("\n");
}
