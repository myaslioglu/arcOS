import type { DropRow } from "./parse";
import type { DropResult } from "./runDrop";

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
 * A row `parseDropList` rejected before a send ever began (a bad address, a bad amount, a
 * duplicate, ...), with everything needed to show it without the user's original list around: the
 * CSV line number, the row's exact original text, and the reason it was excluded. Kept as its own
 * structure (not just the line number) so a send's result can still show what the user actually typed
 * even after the textarea has been replaced with just the unsent remainder — see Window.tsx/
 * ResultPanel.tsx, and the wave E review note this fixes: "lines 4, 9, 17" used to point at text the
 * user could no longer see anywhere on screen.
 */
export type ExcludedRow = { line: number; text: string; reason: string };

/**
 * Describes the rows `parseDropList` rejected before a send ever began — distinct from `failed`
 * (rows the CONTRACT reported as failed transfers, mapped by `failedRowsFor` above). Without this, a
 * result panel that only shows "N delivered" reads as if it covers the whole list, silently dropping
 * any row the parser had already excluded. Returns null (render nothing) when nothing was excluded.
 * Only a summary sentence — the caller renders each row's own `text`/`reason` (see `ExcludedRow`)
 * alongside it, not just this count.
 */
export function excludedRowsText(rows: readonly ExcludedRow[]): string | null {
  if (rows.length === 0) return null;
  if (rows.length === 1) return `1 row wasn't sent because it had a problem: line ${rows[0].line}`;
  return `${rows.length} rows weren't sent because they had problems: lines ${rows.map((r) => r.line).join(", ")}`;
}

/**
 * Which of `hashes` belongs to the batch `runDrop` reported as `unconfirmed` — `null` unless the
 * run actually stopped that way (wave G, N1). `runDrop.ts` always pushes an unconfirmed batch's
 * hash right before returning (see `BatchOutcome`'s doc comment there), so it is the LAST hash
 * recorded; this makes that otherwise-implicit ordering an explicit, tested fact `ResultPanel.tsx`
 * can rely on instead of assuming it on its own.
 */
export function unconfirmedHash(result: Pick<DropResult, "hashes" | "stoppedBecause">): string | null {
  if (result.stoppedBecause !== "unconfirmed") return null;
  return result.hashes.at(-1) ?? null;
}

/**
 * Whether a finished result may be cleared away — by the panel's "Done" button, and by starting the
 * next send over it (see session.ts's reducer, which refuses both while this is false). An
 * unconfirmed batch's rows live ONLY in `result.unconfirmed`: they are deliberately kept out of
 * `remaining` and out of the textarea (see runDrop.ts), so clearing the result destroys them along
 * with the hash needed to find out whether that batch landed — and if it didn't, those recipients
 * are unrecoverable in the app. The two buttons in the unconfirmed section are the way out; either
 * one empties `unconfirmed`.
 */
export function canDismissResult(result: Pick<DropResult, "unconfirmed"> | null): boolean {
  return result === null || result.unconfirmed.length === 0;
}

/**
 * The "N rows weren't sent" banner shown above the textarea once a session's result is ready
 * (wave G, N2). `remaining` alone undercounts once the run stopped because a batch came back
 * unconfirmed: that batch's own rows are in `unconfirmed`, never `remaining` (see runDrop.ts —
 * putting them in `remaining` would invite sending them a second time), so a banner naming only
 * `remaining.length` silently reads as if it covers the whole story. Names both counts in that
 * case; otherwise unchanged from the original wording. `null` when nothing is unsent at all.
 */
export function remainingBannerText(result: Pick<DropResult, "remaining" | "unconfirmed" | "stoppedBecause">): string | null {
  const unconfirmed = result.unconfirmed.length;
  const remaining = result.remaining.length;
  if (result.stoppedBecause === "unconfirmed" && unconfirmed > 0) {
    const unconfirmedPart = unconfirmed === 1 ? "1 row is unconfirmed — see below." : `${unconfirmed} rows are unconfirmed — see below.`;
    if (remaining === 0) return unconfirmedPart;
    const remainingPart = remaining === 1 ? "1 row wasn't sent and is in the list." : `${remaining} rows weren't sent and are in the list.`;
    return `${unconfirmedPart} ${remainingPart}`;
  }
  if (remaining === 0) return null;
  return remaining === 1
    ? "1 row wasn't sent. It's in the list below — check and send again."
    : `${remaining} rows weren't sent. They're in the list below — check and send again.`;
}
