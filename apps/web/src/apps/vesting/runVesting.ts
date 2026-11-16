import type { Address } from "@arcos/chain";
import { describeContractError, isUserRejection } from "@/lib/contract-error";
import type { DropRow } from "@/lib/recipient-list";

/** What creating one schedule came to. A row that fails on its own (a revert, a balance too low) doesn't stop the others. */
export type RowOutcome =
  | { status: "created"; hash: string; vesting: Address | null }
  | { status: "failed"; message: string; hash?: string }
  /** The transaction was sent but its receipt couldn't be read: it may have landed, so nothing after it is sent. */
  | { status: "unconfirmed"; hash: string };

export type RowState =
  | { status: "waiting" }
  | { status: "creating" }
  | { status: "created"; hash: string; vesting: Address | null }
  | { status: "failed"; message: string; hash?: string }
  | { status: "unconfirmed"; hash: string }
  | { status: "not_sent" };

export type VestingRunResult = {
  /** One entry per row, in order. */
  states: RowState[];
  stoppedBecause: null | "rejected" | "error" | "unconfirmed";
  /** A plain sentence, set exactly when `stoppedBecause` is. */
  message: string | null;
};

export type RunDeps = {
  /** Creates the schedule for one row and resolves when it is mined. Throws to stop the run (a refused signature, a changed fee). */
  createRow(row: DropRow, index: number): Promise<RowOutcome>;
  /** Called as each row's state changes, for the progress list. */
  onState?(index: number, state: RowState, states: readonly RowState[]): void;
};

/**
 * Creates one schedule per row, in order, one transaction at a time, and never twice for the same row.
 *
 * - A row that fails by itself is recorded as failed and the run goes on: the rows are independent.
 * - A thrown error stops the run: a refused signature ("rejected") or any other error. The failing row and every row
 *   after it are "not sent".
 * - An unconfirmed row (sent, receipt unknown) stops the run too, and is never retried, since it may have landed.
 */
export async function runVesting(rows: readonly DropRow[], deps: RunDeps): Promise<VestingRunResult> {
  const states: RowState[] = rows.map(() => ({ status: "waiting" }));
  const set = (i: number, s: RowState) => {
    states[i] = s;
    deps.onState?.(i, s, states);
  };
  const result: VestingRunResult = { states, stoppedBecause: null, message: null };

  for (let i = 0; i < rows.length; i++) {
    set(i, { status: "creating" });
    let outcome: RowOutcome;
    try {
      outcome = await deps.createRow(rows[i], i);
    } catch (err) {
      for (let j = i; j < rows.length; j++) set(j, { status: "not_sent" });
      result.stoppedBecause = isUserRejection(err) ? "rejected" : "error";
      result.message = describeContractError(err);
      return result;
    }
    if (outcome.status === "unconfirmed") {
      set(i, outcome);
      for (let j = i + 1; j < rows.length; j++) set(j, { status: "not_sent" });
      result.stoppedBecause = "unconfirmed";
      result.message = `Row ${i + 1} was sent but isn't confirmed. Check the explorer before you create it again.`;
      return result;
    }
    set(i, outcome);
  }
  return result;
}

export type RunSummary = { created: number; failed: number; notSent: number; unconfirmed: number };

export function summarize(states: readonly RowState[]): RunSummary {
  const count = (s: RowState["status"]) => states.filter((x) => x.status === s).length;
  return { created: count("created"), failed: count("failed"), notSent: count("not_sent") + count("waiting") + count("creating"), unconfirmed: count("unconfirmed") };
}

/** The rows that still need doing, as `address,amount` text's source: the failed and not-sent ones, never the unconfirmed. */
export function leftoverRows(rows: readonly DropRow[], states: readonly RowState[]): DropRow[] {
  return rows.filter((_, i) => states[i]?.status === "failed" || states[i]?.status === "not_sent");
}

/** One plain sentence for the result: "2 of 3 schedules created. 1 failed." */
export function summaryText(rows: number, s: RunSummary): string {
  const parts = [`${s.created} of ${rows} ${rows === 1 ? "schedule" : "schedules"} created.`];
  if (s.failed > 0) parts.push(`${s.failed} failed.`);
  if (s.notSent > 0) parts.push(`${s.notSent} not sent.`);
  if (s.unconfirmed > 0) parts.push(`${s.unconfirmed} not confirmed.`);
  return parts.join(" ");
}
