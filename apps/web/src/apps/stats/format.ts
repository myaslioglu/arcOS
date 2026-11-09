// The words the Stats window shows, from the numbers the route answers. Pure: every time comes in as milliseconds.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** A count with thousands separators, the same in every locale: "12,345". */
export const numberText = (n: number): string => n.toLocaleString("en-US");

/** "since 25 Sep 2026" from a UTC date "2026-09-25"; nothing when there is no date. */
export function sinceText(date: string | null): string {
  const m = date === null ? null : /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && month ? `since ${Number(m[3])} ${month} ${m[1]}` : "";
}

/** How old a time is: "just now" under a minute, then minutes, hours up to two days, then days. */
export function ageText(thenMs: number, nowMs: number): string {
  const d = Math.max(0, nowMs - thenMs);
  if (d < MINUTE) return "just now";
  if (d < HOUR) return `${Math.floor(d / MINUTE)} min ago`;
  if (d < 2 * DAY) return `${Math.floor(d / HOUR)} h ago`;
  return `${Math.floor(d / DAY)} d ago`;
}

/**
 * Counting is behind the chain by more than this many blocks (about 17 minutes at Arc's half-second blocks): the
 * numbers are partial, as in the first hours after the counter starts, or while its step is stopped.
 */
export const CATCHING_UP_BLOCKS = 2_000;
