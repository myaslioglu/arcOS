import { explorerUrl } from "@arcos/chain";
import { shortAddress } from "@/lib/format";
import { excludedRowsText, unconfirmedHash, type ExcludedRow } from "./result";
import type { DropResult } from "./useDrop";

export function ResultPanel({
  result,
  excludedRows,
  onCopyFailed,
  onCopyUnconfirmed,
  onUnconfirmedChecked,
  onRecoverUnconfirmed,
}: {
  result: DropResult;
  /** Rows the parser rejected before this send began, with their original text and reason — see
   * session.ts's excludedRows and result.ts's ExcludedRow. */
  excludedRows: ExcludedRow[];
  onCopyFailed: () => void;
  /** Copies `result.unconfirmed`'s rows to the clipboard (N1), same clipboard/formatting helper as
   * `onCopyFailed`. */
  onCopyUnconfirmed: () => void;
  /** "It landed — I checked": dismisses the unconfirmed section without touching the send list. */
  onUnconfirmedChecked: () => void;
  /** "It didn't land — put these rows back in the list": the ONLY way `result.unconfirmed`'s rows
   * re-enter the send list — a deliberate click, never automatic. */
  onRecoverUnconfirmed: () => void;
}) {
  const excludedText = excludedRowsText(excludedRows);
  const hash = unconfirmedHash(result);
  return (
    <div className="mt-4 rounded-md border border-border-2 p-3 text-xs">
      <p className="text-sm font-medium">{result.delivered.length} delivered</p>
      {/* Stated explicitly, separate from the send's own outcome, so "N delivered" never reads as
          covering rows that were never attempted in the first place. Each row's own ORIGINAL TEXT is
          shown, not just its line number: by the time this panel renders, the textarea above has
          already been replaced with just the unsent remainder, so a line number alone would point at
          text the user can no longer see anywhere. */}
      {excludedText && (
        <div className="mt-1 text-accent-3-text">
          <p>{excludedText}</p>
          <ul className="mt-1 max-h-32 overflow-auto">
            {excludedRows.map((r) => (
              <li key={r.line} className="break-all">
                Line {r.line}: <span className="font-mono">{r.text}</span> — {r.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.message && <p className="mt-1 text-accent-3-text">{result.message}</p>}
      {/* N1: a batch that was sent but couldn't be confirmed — its rows are deliberately kept out of
          both `delivered` and `remaining` (see runDrop.ts), so without this section they'd be
          invisible and unrecoverable if the send genuinely didn't land. Two explicit, separate
          actions below — neither is automatic. */}
      {result.unconfirmed.length > 0 && (
        <div className="mt-3 rounded-md border border-border-2 p-2">
          <p className="font-medium text-accent-3-text">This batch was sent but not confirmed</p>
          {hash && (
            <a className="mt-1 block break-all text-accent-text" href={explorerUrl("tx", hash)} target="_blank" rel="noreferrer">
              Check this transaction on the explorer
            </a>
          )}
          <ul className="mt-2 max-h-32 overflow-auto">
            {result.unconfirmed.map((r) => (
              <li key={r.line}>
                Line {r.line}: {shortAddress(r.address)}
              </li>
            ))}
          </ul>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className="rounded-md border border-border-2 px-2 py-1" onClick={onCopyUnconfirmed}>
              Copy these rows
            </button>
            <button type="button" className="rounded-md border border-border-2 px-2 py-1" onClick={onUnconfirmedChecked}>
              It landed — I checked
            </button>
            <button type="button" className="rounded-md border border-border-2 px-2 py-1" onClick={onRecoverUnconfirmed}>
              {"It didn't land — put these rows back in the list"}
            </button>
          </div>
        </div>
      )}
      {result.failed.length > 0 && (
        <>
          <ul className="mt-2 max-h-32 overflow-auto">
            {result.failed.map((f) => (
              <li key={f.line}>
                Line {f.line}: {shortAddress(f.address)}
              </li>
            ))}
          </ul>
          <button type="button" className="mt-2 rounded-md border border-border-2 px-2 py-1" onClick={onCopyFailed}>
            Copy failed rows
          </button>
        </>
      )}
      {result.hashes.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {result.hashes.map((h) => (
            <li key={h}>
              <a className="text-accent-text" href={explorerUrl("tx", h)} target="_blank" rel="noreferrer">
                {shortAddress(h)}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
