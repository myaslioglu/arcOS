/** Turning what a person types for a duration, a cliff and a start into seconds, and seconds back into words. Pure. */

export const SPAN_UNITS = ["minutes", "hours", "days", "weeks", "years"] as const;
export type SpanUnit = (typeof SPAN_UNITS)[number];

const SECONDS: Record<SpanUnit, bigint> = {
  minutes: 60n,
  hours: 3_600n,
  days: 86_400n,
  weeks: 604_800n,
  years: 31_536_000n, // 365 days
};

/**
 * A whole number of `unit`s, in seconds. Null for an empty or malformed field: the form then says what it needs. A
 * decimal isn't read, since "1.5 years" and "1,5" invite a wrong guess; use a smaller unit.
 */
export function parseSpan(text: string, unit: SpanUnit): bigint | null {
  const t = text.trim();
  if (!/^\d{1,9}$/.test(t)) return null;
  return BigInt(t) * SECONDS[unit];
}

/** `parseSpan` for the cliff, where an empty field means none. */
export function parseCliff(text: string, unit: SpanUnit): bigint | null {
  return text.trim() === "" ? 0n : parseSpan(text, unit);
}

/**
 * The start time: now, or a "YYYY-MM-DDTHH:mm" value from a datetime-local input read as the browser's local time.
 * Null when the date is missing or not a date.
 */
export function parseStart(mode: "now" | "date", text: string, nowSeconds: bigint): bigint | null {
  if (mode === "now") return nowSeconds;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(text.trim())) return null;
  const ms = new Date(text.trim()).getTime();
  return Number.isFinite(ms) ? BigInt(Math.floor(ms / 1000)) : null;
}

const plural = (n: bigint, one: string) => `${n} ${one}${n === 1n ? "" : "s"}`;

/** "1 year", "90 days", "36 hours", "45 seconds": the largest unit that divides the span evenly. */
export function spanText(seconds: bigint): string {
  if (seconds === 0n) return "0 seconds";
  for (const [unit, label] of [
    ["years", "year"],
    ["weeks", "week"],
    ["days", "day"],
    ["hours", "hour"],
    ["minutes", "minute"],
  ] as const) {
    const size = SECONDS[unit];
    if (seconds % size === 0n) return plural(seconds / size, label);
  }
  return plural(seconds, "second");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "16 Nov 2026, 12:00 UTC": a moment in UTC, so every reader sees the same one. */
export function utcText(seconds: bigint): string {
  const d = new Date(Number(seconds) * 1000);
  if (!Number.isFinite(d.getTime())) return "?";
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}
