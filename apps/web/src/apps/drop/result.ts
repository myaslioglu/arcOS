import type { DropRow } from "./parse";

export type FailedRow = { line: number; address: string; amount: bigint };

/** A decoded `TransferFailed` log's args. `index` is the row's position WITHIN the batch it was sent in, not
 * an offset into the whole CSV — that's why mapping it back to a line needs the batch that produced it. */
export type TransferFailedArgs = { index: bigint; recipient: string; amount: bigint };

/**
 * Maps a batch's `TransferFailed` logs back to the CSV line each failure came from, using the same batch
 * (`DropRow[]`) that was sent on chain. An index the batch doesn't have — which should never happen, since
 * the contract only ever emits an index below the batch length it received — is ignored rather than
 * crashing the result screen.
 */
export function failedRowsFor(batch: DropRow[], failures: readonly { args: TransferFailedArgs }[]): FailedRow[] {
  const out: FailedRow[] = [];
  for (const f of failures) {
    const row = batch[Number(f.args.index)];
    if (row) out.push({ line: row.line, address: f.args.recipient, amount: f.args.amount });
  }
  return out;
}
