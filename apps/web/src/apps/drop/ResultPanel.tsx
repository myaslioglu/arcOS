import { explorerUrl } from "@arcos/chain";
import { shortAddress } from "@/lib/format";
import { excludedRowsText, type ExcludedRow } from "./result";
import type { DropResult } from "./useDrop";

export function ResultPanel({
  result,
  excludedRows,
  onCopyFailed,
}: {
  result: DropResult;
  /** Rows the parser rejected before this send began, with their original text and reason — see
   * session.ts's excludedRows and result.ts's ExcludedRow. */
  excludedRows: ExcludedRow[];
  onCopyFailed: () => void;
}) {
  const excludedText = excludedRowsText(excludedRows);
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
