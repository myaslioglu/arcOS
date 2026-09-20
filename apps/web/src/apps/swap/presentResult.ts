import type { SwapResult } from "@circle-fin/app-kit";
import type { Tone } from "@arcos/shell";

export type SwapPresentation = {
  /** Matches @arcos/shell's `notify()` tone directly, so the caller can pass it straight through. */
  tone: Tone;
  headline: string;
  /** The SDK's own explanation for a failure, or null when there isn't one (or nothing failed). */
  reason: string | null;
  txHash: string;
  explorerUrl: string | null;
  /** True only for `progress.status === 'DONE'` — the one status that means the swap actually
   * completed. Gates the `swap_success` analytics event and the "Received ≈" line. */
  isSuccess: boolean;
};

/**
 * Maps the SDK's terminal statuses to what the user sees — the single place that decides "did this
 * swap actually work", so a failure can never accidentally render with success styling.
 *
 * Only `DONE` is success. `FAILED` and `NOT_FOUND` are failures, shown with a warning and the SDK's
 * own reason. Anything else (`PENDING`, or a status this app doesn't recognize) is shown neutrally
 * — submitted, not yet confirmed either way — never guessed as a success.
 */
export function presentSwapResult(result: SwapResult): SwapPresentation {
  const { status, substatusMessage } = result.progress;
  const txHash = result.txHash;
  const explorerUrl = result.explorerUrl ?? null;

  if (status === "DONE") {
    return { tone: "ok", headline: "Swap complete", reason: null, txHash, explorerUrl, isSuccess: true };
  }
  if (status === "FAILED" || status === "NOT_FOUND") {
    const reason = substatusMessage ?? (status === "NOT_FOUND" ? "The swap service has no record of this transaction." : "The swap failed.");
    return { tone: "warn", headline: "Swap didn't go through", reason, txHash, explorerUrl, isSuccess: false };
  }
  return { tone: "info", headline: "Swap submitted — check the transaction", reason: null, txHash, explorerUrl, isSuccess: false };
}
