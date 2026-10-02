/** The most blocks one eth_getLogs may span on Arc, inclusive (F5: 10,000 answers, 10,001 is -32012). */
export const MAX_WINDOW = 10_000;

/** The first run's backfill: 24 hours at about 0.507 s a block (F8). Explicit and bounded; never from genesis. */
export const BACKFILL_BLOCKS = 170_000;

/** The cursor a first run starts from: the last block counted as handled, so the first window begins one after it. */
export function firstCursor(head: number, backfill = BACKFILL_BLOCKS): number {
  return Math.max(0, head - backfill);
}

/** The next window after `cursor`, at most `span` blocks and never past `head`; null when there is nothing new. */
export function nextWindow(cursor: number, head: number, span: number): { from: number; to: number } | null {
  if (cursor >= head) return null;
  const from = cursor + 1;
  const width = Math.max(1, Math.min(span, MAX_WINDOW));
  return { from, to: Math.min(head, from + width - 1) };
}

/**
 * The span to try after the node refused one (-32012 range too large, or -32602 too many results): half of it, or the
 * width the node suggested when that is smaller, and never under one block.
 */
export function shrink(span: number, suggested?: number): number {
  const half = Math.floor(span / 2);
  const next = suggested !== undefined && suggested > 0 && suggested < half ? suggested : half;
  return Math.max(1, next);
}

/** The span after a window that went through: double, up to the cap. */
export function grow(span: number): number {
  return Math.min(MAX_WINDOW, span * 2);
}
