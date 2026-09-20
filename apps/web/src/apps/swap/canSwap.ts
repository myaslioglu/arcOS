/** The three states `useQuery`'s own `status` field takes (v5's `QueryStatus`), named locally so
 * this module has no dependency on @tanstack/react-query — the caller passes `estimateQuery.status`
 * straight in, which is structurally identical. */
export type EstimateStatus = "pending" | "error" | "success";

export type CanSwapInput = {
  /** A swap is in flight — this window's submit, another Swap window's, or a reopened one's. */
  sessionActive: boolean;
  hasConnector: boolean;
  /** The exact text in the amount box right now — this is what actually gets swapped (see
   * Window.tsx's submit()), never the debounced value. */
  liveAmount: string;
  /** The debounced value the estimate query is keyed on. Only trustworthy once it matches
   * `liveAmount` — see the "stale-debounce" test for the bug this guards against. */
  debouncedAmount: string;
  amountIssue: string | null;
  estimateStatus: EstimateStatus;
};

export type CanSwapResult = { ok: boolean; label: string };

/**
 * The single source of truth for whether the Swap button is clickable and what it says, so the two
 * can never disagree. Checked in order; the first false condition wins and sets the label.
 *
 * CRITICAL: the amount that gets submitted is always the live text box (`liveAmount`), never the
 * debounced one — this function is what keeps the button in lockstep with that fact. It refuses to
 * enable until the debounced estimate has caught up to what's on screen, so by the time it says
 * `ok: true` a successful estimate exists for exactly the amount and pair the user is looking at.
 */
export function canSwap(input: CanSwapInput): CanSwapResult {
  const { sessionActive, hasConnector, liveAmount, debouncedAmount, amountIssue, estimateStatus } = input;
  if (sessionActive) return { ok: false, label: "Waiting for your wallet…" };
  if (liveAmount !== debouncedAmount) return { ok: false, label: "Updating the quote…" };
  const ok = hasConnector && !amountIssue && estimateStatus === "success";
  return { ok, label: "Swap" };
}
