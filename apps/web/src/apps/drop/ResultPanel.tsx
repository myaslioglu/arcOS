import { explorerUrl } from "@arcos/chain";
import { shortAddress } from "@/lib/format";
import { excludedRowsText } from "./result";
import type { DropResult } from "./useDrop";

export function ResultPanel({
  result,
  excludedLines,
  onCopyFailed,
}: {
  result: DropResult;
  /** CSV line numbers the parser rejected before this send began — see session.ts's excludedLines. */
  excludedLines: number[];
  onCopyFailed: () => void;
}) {
  const excludedText = excludedRowsText(excludedLines);
  return (
    <div className="mt-4 rounded-md border border-border-2 p-3 text-xs">
      <p className="text-sm font-medium">{result.delivered.length} delivered</p>
      {/* Stated explicitly, separate from the send's own outcome, so "N delivered" never reads as
          covering rows that were never attempted in the first place. */}
      {excludedText && <p className="mt-1 text-accent-3-text">{excludedText}</p>}
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
