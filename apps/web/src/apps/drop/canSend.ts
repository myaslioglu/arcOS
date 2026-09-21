export type CanSendInput = {
  /** This component's own submit() call hasn't settled yet — a local, same-tick safety net. `sessionActive`
   * is the authoritative guard once the shared session store reflects it (which happens synchronously, but
   * a moment before this component necessarily re-renders from it). */
  busy: boolean;
  ready: boolean;
  /** The active token's `decimals` resolved to a number — false while it's still loading OR failed to
   * read; either way there's no safe scale to parse or send amounts at. */
  decimalsKnown: boolean;
  /** `text === deferredText`. False for the paintable moment after a send resolves and `setText` commits
   * before `useDeferredValue` catches up — the displayed row count can't be trusted yet, so a click here
   * must not be allowed to re-send whatever the deferred (stale) parse still shows. */
  textIsCurrent: boolean;
  /** How many valid rows the CURRENT (non-deferred) parse produced — only trustworthy when `textIsCurrent`. */
  rowCount: number;
  /** Accepted for documentation and tests, not used to disable: a bad row is excluded, not fatal — see the
   * "issues present" test in canSend.test.ts for the decision this encodes. */
  issueCount: number;
  /** A send is in progress — in this window, another Drop window, or one this window doesn't remember
   * because it was closed and reopened mid-send. */
  sessionActive: boolean;
  /** The row count the most recently fetched fee quote was computed for, or `null` while there's no
   * usable quote (still loading, or the read failed). Must equal `rowCount` for the quote to be
   * trusted: the quote is fetched debounced (300ms after `rowCount` last changed), so pasting more
   * rows over a shorter list and clicking Send inside that window must not let a stale quote — still
   * showing the OLD, shorter list's fee — authorize sending the NEW, longer one (wave E, I1). */
  quoteCount: number | null;
};

export type CanSendResult = { ok: boolean; label: string };

/**
 * The single source of truth for whether the Send button is clickable and what it says, so the two can
 * never disagree. Checked in order; the first false condition wins and sets the label.
 */
export function canSend(input: CanSendInput): CanSendResult {
  const { busy, ready, decimalsKnown, textIsCurrent, rowCount, sessionActive, quoteCount } = input;
  if (busy || sessionActive) return { ok: false, label: "Sending…" };
  if (!textIsCurrent) return { ok: false, label: "Checking the list…" };
  if (!decimalsKnown || !ready) return { ok: false, label: `Send to ${rowCount} wallets` };
  if (rowCount === 0) return { ok: false, label: "Send to 0 wallets" };
  if (quoteCount !== rowCount) return { ok: false, label: "Reading the fee…" };
  return { ok: true, label: `Send to ${rowCount} wallets` };
}
