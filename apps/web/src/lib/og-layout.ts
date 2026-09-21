/**
 * The OG card's vertical budget, kept out of `og-card.tsx` so it can be unit-tested without a JSX
 * transform — and so the number of finding rows the card shows is a computed consequence of what
 * else is on it rather than a literal someone has to remember to lower.
 *
 * Why it matters: the card is a fixed 1200x630 box, and overflowing it doesn't cut the bottom off.
 * satori SHRINKS the overflowing children, so one row too many collapses the symbol, the pass line
 * and the explorer note into each other and the card reads as broken. The first thing to go is the
 * footer — the disclosure that the token's name was chosen by whoever deployed it.
 */

export const OG_CARD = { width: 1200, height: 630, padding: 48 } as const;

/** 630 minus the 48px padding top and bottom. */
export const OG_CONTENT_HEIGHT = OG_CARD.height - 2 * OG_CARD.padding;

/**
 * Held back from the budget. These are nominal line heights; satori's own text metrics differ a
 * little, longer text can wrap, and the failure mode isn't a clipped pixel row but a card whose
 * header and body overlap. Half a row is cheap insurance.
 */
export const OG_SLACK = 23;

/**
 * Every box the card stacks, in px, each including the margin above it. This list is the budget's
 * only source of truth, so it has to be kept beside what `ogCard` actually renders: a line added
 * there and not here would be spent out of the slack and then out of the footer.
 */
const STACK = {
  kicker: 31,
  symbol: 77 + 12,
  passLine: 48 + 4,
  explorerNote: 27 + 6,
  /** Space above the rows block. */
  rowsTop: 24,
  row: 46,
  /** The "+N more" line. Always budgeted for: a card that hides nothing just has one row of extra
   * slack, which is better than a budget that only holds when nothing is hidden. */
  moreRow: 46,
  footer: 16 + 27,
  disclosure: 22 + 4,
} as const;

/** What the card spends with `rows` finding rows on it. */
export function ogStackHeight(rows: number, showsExplorerNote: boolean): number {
  return (
    STACK.kicker +
    STACK.symbol +
    STACK.passLine +
    (showsExplorerNote ? STACK.explorerNote : 0) +
    STACK.rowsTop +
    rows * STACK.row +
    STACK.moreRow +
    STACK.footer +
    STACK.disclosure
  );
}

/**
 * How many finding rows fit. The explorer note is shown whenever the explorer didn't answer, which
 * is the NORMAL case for the server-side run on mainnet (the explorer sits behind a bot check), so
 * that is the case the budget has to hold for — it just leaves room for one more row when the note
 * isn't there. `rankFindings` fills the rows worst-first, so what "+N more" hides is never the
 * worst news.
 */
export function findingRowBudget(showsExplorerNote: boolean): number {
  const room = OG_CONTENT_HEIGHT - OG_SLACK - ogStackHeight(0, showsExplorerNote);
  return Math.max(1, Math.floor(room / STACK.row));
}
