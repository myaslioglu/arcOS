import { describeContractError } from "@/lib/contract-error";
import { chunk, type DropRow } from "./parse";
import { failedRowsFor, type FailedRow } from "./result";

/**
 * What one batch attempt resolved to. `failures` are the rows this batch's contract call itself reported
 * as failed transfers (not a revert): `index` is that row's position WITHIN the batch, mirroring the
 * contract's `TransferFailed` event.
 *
 * `"unconfirmed"` is a batch whose transaction WAS broadcast (a real `hash`) but whose receipt could
 * not be obtained — an RPC timeout or dropped connection, not a decoded outcome. It is deliberately a
 * third status, not folded into a `sendBatch` rejection: whether the batch actually landed is unknown,
 * so its rows must never be treated as either delivered or safely re-sendable — see `runDrop`'s
 * handling below and the wave E brief's fund-safety note on this exact hazard.
 */
export type BatchOutcome = {
  hash: string;
  status: "success" | "reverted" | "unconfirmed";
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
  /** Rows of a batch whose transaction was broadcast but whose receipt couldn't be confirmed — neither
   * delivered nor safe to put back in `remaining` (that would risk sending them twice). See
   * `BatchOutcome`'s "unconfirmed" status. Always empty unless `stoppedBecause === "unconfirmed"`. */
  unconfirmed: DropRow[];
  hashes: string[];
  stoppedBecause: null | "rejected" | "reverted" | "error" | "unconfirmed";
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
  const result: DropResult = { delivered: [], failed: [], remaining: [], unconfirmed: [], hashes: [], stoppedBecause: null, message: null };

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    let outcome: BatchOutcome;
    try {
      outcome = await deps.sendBatch(batch, i + 1);
    } catch (err) {
      result.remaining.push(...batches.slice(i).flat());
      result.stoppedBecause = isUserRejection(err) ? "rejected" : "error";
      // describeContractError, not the wallet/RPC's own message: a batch failure here can be a
      // decoded contract revert (WrongValue, ZeroAmount, BadLists, ...) or raw transport detail —
      // either way the user gets one plain sentence, never raw RPC text (see lib/contract-error.ts).
      result.message = describeContractError(err);
      return result;
    }

    if (outcome.status === "reverted") {
      result.hashes.push(outcome.hash);
      result.remaining.push(...batches.slice(i).flat());
      result.stoppedBecause = "reverted";
      result.message = `Batch ${i + 1} of ${batches.length} reverted — nothing in it was sent.`;
      return result;
    }

    if (outcome.status === "unconfirmed") {
      // This batch's transaction was broadcast — it may already be mined and delivered — so its rows
      // go to `unconfirmed`, never to `remaining` (which would invite sending them a second time) and
      // never to `delivered` (nothing confirms they landed). Every batch after this one was never
      // attempted at all, so those rows are still safe to put back in `remaining`. The run stops here
      // either way: continuing against an RPC/wallet that just failed to confirm a receipt is not safe.
      result.hashes.push(outcome.hash);
      result.unconfirmed.push(...batch);
      result.remaining.push(...batches.slice(i + 1).flat());
      result.stoppedBecause = "unconfirmed";
      result.message = `Batch ${i + 1} of ${batches.length} was sent but is unconfirmed — check the explorer before sending the rest.`;
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
