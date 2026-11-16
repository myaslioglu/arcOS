import { formatUnits } from "viem";
import { explorerUrl } from "@arcos/chain";
import { displayAmount } from "@/lib/display-amount";
import { shortAddress } from "@/lib/format";
import { leftoverRows, summarize, summaryText, type RowState } from "./runVesting";
import type { VestingSession } from "./session";

type Active = Extract<VestingSession, { status: "running" | "done" }>;

const BUTTON = "min-h-8 rounded-md border border-border-2 px-3 text-xs pointer-coarse:min-h-11 disabled:opacity-50";

function stateText(s: RowState): string {
  switch (s.status) {
    case "waiting":
      return "Waiting";
    case "creating":
      return "Creating…";
    case "created":
      return "Created";
    case "failed":
      return `Failed. ${s.message}`;
    case "unconfirmed":
      return "Sent, not confirmed";
    case "not_sent":
      return "Not sent";
  }
}

/** The run's progress while it goes, and its result when it is over: one line per row, so a failed row is never hidden in a count. */
export function RunPanel({
  run,
  onDone,
  onReuse,
  onOpenRevoke,
}: {
  run: Active;
  onDone: () => void;
  /** Puts the failed and unsent rows back into the form's list. */
  onReuse: (rows: ReturnType<typeof leftoverRows>) => void;
  onOpenRevoke: () => void;
}) {
  const done = run.status === "done";
  const total = run.rows.reduce((s, r) => s + r.amount, 0n);
  const sum = summarize(run.states);
  const current = run.states.findIndex((s) => s.status === "creating");
  const left = done ? leftoverRows(run.rows, run.states) : [];
  const amount = (units: bigint) => `${displayAmount(formatUnits(units, run.decimals), { mode: "up" })} ${run.symbol}`;

  return (
    <div className="p-3 text-sm" data-testid="vesting-run">
      {!done && (
        <>
          <p className="font-medium" aria-live="polite">
            {run.step === "approve" ? `Approve ${amount(total)} in your wallet…` : `Creating schedule ${current + 1 || run.rows.length} of ${run.rows.length}…`}
          </p>
          <p className="mt-1 text-xs text-muted">Keep this tab open until it finishes. You can close this window; the run continues.</p>
        </>
      )}
      {done && (
        <>
          <p className="font-medium">{run.result ? summaryText(run.rows.length, sum) : "No schedule was created."}</p>
          {run.approvalMessage && <p className="mt-1 text-accent-3-text">{`The approval wasn't set. ${run.approvalMessage}`}</p>}
          {run.result?.message && <p className="mt-1 text-accent-3-text">{run.result.message}</p>}
        </>
      )}
      <ul className="mt-3 max-h-56 overflow-auto rounded-md border border-border-2 text-xs">
        {run.rows.map((row, i) => {
          const state = run.states[i];
          return (
            <li key={row.line} className="flex flex-wrap items-baseline gap-x-2 border-b border-border-2 px-2 py-1.5 last:border-b-0">
              <span className="text-muted">Line {row.line}</span>
              <span className="font-mono">{shortAddress(row.address)}</span>
              <span>{amount(row.amount)}</span>
              <span className={state.status === "failed" || state.status === "unconfirmed" ? "text-accent-3-text" : "text-muted"}>{stateText(state)}</span>
              {state.status === "created" && state.vesting && (
                <a className="text-accent-text" href={explorerUrl("address", state.vesting)} target="_blank" rel="noreferrer">
                  View the vesting contract
                </a>
              )}
              {(state.status === "created" || state.status === "unconfirmed" || (state.status === "failed" && state.hash)) && (
                <a className="text-accent-text" href={explorerUrl("tx", state.hash!)} target="_blank" rel="noreferrer">
                  Transaction
                </a>
              )}
            </li>
          );
        })}
      </ul>
      {done && run.leftoverAllowance !== null && run.leftoverAllowance > 0n && (
        <div className="mt-3 rounded-md border border-border-2 p-2 text-xs">
          <p>{`The vesting contract can still take up to ${amount(run.leftoverAllowance)} from your wallet, left over from this run's approval. Remove it in Revoke when you are done.`}</p>
          <button type="button" className={`${BUTTON} mt-2`} onClick={onOpenRevoke}>
            Open Revoke
          </button>
        </div>
      )}
      {done && (
        <div className="mt-3 flex flex-wrap gap-2">
          {left.length > 0 && (
            <button type="button" className={BUTTON} onClick={() => onReuse(left)}>
              Put the unfinished rows back in the list
            </button>
          )}
          <button type="button" className={BUTTON} onClick={onDone}>
            Done
          </button>
        </div>
      )}
    </div>
  );
}
