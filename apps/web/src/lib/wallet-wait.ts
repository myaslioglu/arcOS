import { useEffect, useState } from "react";

/**
 * How long a wallet request may go unanswered before the window says so and offers "Stop waiting". App Kit bounds its
 * own HTTP calls, but not the wallet's: an approval, a permit signature or a send that the wallet never shows, or loses
 * (a WalletConnect session on a phone, a locked extension), keeps the kit's promise open for good.
 */
export const WALLET_WAIT_NOTICE_MS = 75_000;

/**
 * Calls `onDue` once `ms` have passed since `startedAt` (a `Date.now()` time), or on the next tick when they already
 * have: a session lives outside the window, so a window reopened late shows the notice at once. Returns the cancel.
 */
export function scheduleWaitNotice(startedAt: number, onDue: () => void, ms: number = WALLET_WAIT_NOTICE_MS, now: number = Date.now()): () => void {
  const id = setTimeout(onDue, Math.max(0, startedAt + ms - now));
  return () => clearTimeout(id);
}

/**
 * True once run `runId`, started at `startedAt`, has waited `ms` or longer. Pass `null` when nothing is waiting. Keyed by
 * the run, so a new run starts with the notice hidden.
 */
export function useWaitedTooLong(runId: number | null, startedAt: number | null, ms: number = WALLET_WAIT_NOTICE_MS): boolean {
  const [dueRun, setDueRun] = useState<number | null>(null);
  useEffect(() => {
    if (runId === null || startedAt === null) return;
    return scheduleWaitNotice(startedAt, () => setDueRun(runId), ms);
  }, [runId, startedAt, ms]);
  return runId !== null && dueRun === runId;
}
