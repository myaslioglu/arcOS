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

/**
 * Describes the rows `parseDropList` rejected before a send ever began (a bad address, a bad
 * amount, a duplicate, ...) — distinct from `failed` (rows the CONTRACT reported as failed
 * transfers, mapped by `failedRowsFor` above). Without this, a result panel that only shows
 * "N delivered" reads as if it covers the whole list, silently dropping any row the parser had
 * already excluded. Returns null (render nothing) when nothing was excluded.
 */
export function excludedRowsText(lines: readonly number[]): string | null {
  if (lines.length === 0) return null;
  if (lines.length === 1) return `1 row wasn't sent because it had a problem: line ${lines[0]}`;
  return `${lines.length} rows weren't sent because they had problems: lines ${lines.join(", ")}`;
}
