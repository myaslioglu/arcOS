import { chunk, type DropRow } from "./parse";
import { failedRowsFor, type FailedRow } from "./result";

/**
 * What one batch attempt resolved to. `failures` are the rows this batch's contract call itself reported
 * as failed transfers (not a revert): `index` is that row's position WITHIN the batch, mirroring the
 * contract's `TransferFailed` event.
 */
export type BatchOutcome = {
  hash: string;
  status: "success" | "reverted";
  failures: { index: number; amount: bigint }[];
};

export type DropDeps = {
  /** Sends one batch and resolves when it is mined. Rejects if the user refuses to sign or the send can't be made. */
  sendBatch(batch: DropRow[], batchNumber: number): Promise<BatchOutcome>;
};

export type DropResult = {
  /** Rows that landed. A row the contract reported as a per-row failure is never counted here — see `failed`. */
  delivered: DropRow[];
  /** Rows the contract reported as failed transfers, with their original CSV line numbers. */
  failed: FailedRow[];
  /** Rows never attempted, or whose batch reverted or was refused. Never re-attempted automatically. */
  remaining: DropRow[];
  hashes: string[];
  stoppedBecause: null | "rejected" | "reverted" | "error";
  /** Human-readable reason, set exactly when `stoppedBecause` is set. */
  message: string | null;
};

/** True when `err` — or anything in its `cause` chain — looks like a wallet-level user rejection: viem's
 * `UserRejectedRequestError` (by name, so this doesn't need to import viem) or EIP-1193 error code 4001.
 * Exported so the hook can classify the approval step's own failures the same way. */
export function isUserRejection(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const e = current as { name?: unknown; code?: unknown; cause?: unknown };
    if (e.name === "UserRejectedRequestError" || e.code === 4001) return true;
    current = e.cause;
  }
  return false;
}

/** Exported so the hook can build the same human-readable message for the approval step's own failures. */
export function shortMessage(err: unknown): string {
  if (err !== null && typeof err === "object") {
    const short = (err as { shortMessage?: unknown }).shortMessage;
    if (typeof short === "string") return short;
  }
  return err instanceof Error ? err.message : "The transaction didn't go through.";
}

/**
 * Sends `rows` in batches of `batchSize` through `deps.sendBatch`, never reporting a row as delivered
 * unless it actually landed and never sending the same row twice.
 *
 * - A batch whose receipt status is `"reverted"` delivered nothing: every one of its rows goes back to
 *   `remaining` (a revert is systematic — retrying the same batch would revert again), and the loop stops.
 * - A `sendBatch` rejection (a refused signature, an RPC error, a simulate failure, ...) is caught here
 *   rather than thrown: everything already mined stays in `delivered` with its batch's hash, and this
 *   batch plus every batch after it goes to `remaining`.
 * - Otherwise, a batch's per-row failures (reported by the contract, not a revert) are mapped back to their
 *   CSV line numbers and kept out of `delivered`; every other row in the batch is delivered.
 */
export async function runDrop(rows: DropRow[], batchSize: number, deps: DropDeps): Promise<DropResult> {
  const batches = chunk(rows, batchSize);
  const result: DropResult = { delivered: [], failed: [], remaining: [], hashes: [], stoppedBecause: null, message: null };

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    let outcome: BatchOutcome;
    try {
      outcome = await deps.sendBatch(batch, i + 1);
    } catch (err) {
      result.remaining.push(...batches.slice(i).flat());
      result.stoppedBecause = isUserRejection(err) ? "rejected" : "error";
      result.message = shortMessage(err);
      return result;
    }

    if (outcome.status === "reverted") {
      result.hashes.push(outcome.hash);
      result.remaining.push(...batches.slice(i).flat());
      result.stoppedBecause = "reverted";
      result.message = `Batch ${i + 1} of ${batches.length} reverted — nothing in it was sent.`;
      return result;
    }

    result.hashes.push(outcome.hash);
    // TransferFailed carries an index local to this batch and no CSV line, so it's mapped back through the
    // same batch->line helper the real chain path uses; the recipient it needs comes from the batch itself
    // (this outcome shape carries no recipient of its own — batch[index].address is the same value).
    const failedRows = failedRowsFor(
      batch,
      outcome.failures.map((f) => ({ args: { index: BigInt(f.index), recipient: batch[f.index]?.address ?? "", amount: f.amount } })),
    );
    const failedLines = new Set(failedRows.map((f) => f.line));
    result.failed.push(...failedRows);
    for (const row of batch) {
      if (!failedLines.has(row.line)) result.delivered.push(row);
    }
  }

  return result;
}
