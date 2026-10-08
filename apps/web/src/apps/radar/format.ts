import type { TokenSource } from "@arcos/data";

// The words a Radar row shows, from the numbers the route answers. Pure: every time comes in as milliseconds, so the
// window hands in one "now" (the query's dataUpdatedAt) and the tests are deterministic.

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How old a time is: "just now" under a minute, then minutes, hours up to two days, then days. */
export function ageText(thenMs: number, nowMs: number): string {
  const d = Math.max(0, nowMs - thenMs);
  if (d < MINUTE) return "just now";
  if (d < HOUR) return `${Math.floor(d / MINUTE)} min ago`;
  if (d < 2 * DAY) return `${Math.floor(d / HOUR)} h ago`;
  return `${Math.floor(d / DAY)} d ago`;
}

/** A time as "2026-10-08 11:58 UTC", for a tooltip. */
export function utcText(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** "6 of 9 checks pass", or "Not checked yet" until the indexer has inspected the token. */
export function checksText(passed: number | null, total: number | null): string {
  return passed === null || total === null ? "Not checked yet" : `${passed} of ${total} checks pass`;
}

const USDC_UNIT = 1_000_000n;
const BILLION = 1_000_000_000n;

/** A pool depth in USDC's 6-decimal units as whole USDC: "2,500 USDC", "Under 1 USDC", "1B+ USDC". BigInt only. */
export function liquidityText(depth: string): string {
  const whole = BigInt(depth) / USDC_UNIT;
  if (whole === 0n) return "Under 1 USDC";
  if (whole >= BILLION) return "1B+ USDC";
  return `${whole.toLocaleString("en-US")} USDC`;
}

const SOURCE_LABEL: Record<TokenSource, string> = {
  factory: "4rc.OS",
  v2: "Uniswap v2",
  v3: "Uniswap v3",
  v4: "Uniswap v4",
  aero: "Aerodrome",
};

/** Where the index first saw a token: the 4rc.OS TokenFactory, or the pool factory whose pool named it. */
export function sourceLabel(source: TokenSource): string {
  return SOURCE_LABEL[source];
}

/** The indexer runs every minute; a last run older than this, or none reported, means new tokens may be missing. */
export const STALE_AFTER_MS = 10 * MINUTE;

export function isStale(indexedAt: number | null, nowMs: number): boolean {
  return indexedAt === null || nowMs - indexedAt > STALE_AFTER_MS;
}
