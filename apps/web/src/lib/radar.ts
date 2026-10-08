import {
  RADAR_FEED_SIZE,
  RADAR_PASSING_MIN,
  radarFeedFilter,
  type RadarFeedDoc,
  type RadarFeedFilter,
  type RadarRow,
  type TimestampLike,
  type TokenSource,
} from "@arcos/data";
import { cleanLabel } from "@arcos/inspector";
import { launchpadOf } from "./launchpads";

// What GET /api/radar answers: the first Radar page of one of the four feeds, as the indexer stored it, checked row by
// row and with the index's last run. This module is pure: the Firestore read lives in radar-server.ts, and the window
// imports only its types.

/** What the server read (the shape of `@arcos/data/server`'s RadarFeedRead, named here so this module stays pure). */
export type RadarFeedRead = {
  feed: Pick<RadarFeedDoc, "rows"> | null;
  indexer: { lastRunAt: TimestampLike | null } | null;
};

/** One row as the route answers it. `firstSeen` is ISO; `launchpad` is the badge name, the creator itself never leaves. */
export type RadarAnswerRow = {
  address: string;
  symbol: string | null;
  name: string | null;
  source: TokenSource;
  firstSeen: string;
  passed: number | null;
  total: number | null;
  bestPoolDepth: string | null;
  decimals: number | null;
  launchpad: string | null;
};

/** The route's body: at most RADAR_FEED_SIZE rows, newest first, and when the indexer last finished a run. */
export type RadarAnswer = { rows: RadarAnswerRow[]; indexedAt: string | null };

/** A page as the server keeps it: the answer, and how many stored rows were malformed and left out (logged as a count). */
export type RadarPage = RadarAnswer & { skipped: number };

export const BEFORE_ERROR = "Radar lists the newest 50 tokens only.";
export const LIQUIDITY_ERROR = "hasLiquidity can be 0 or 1.";
export const PASSED_ERROR = "minPassed can be 0 or 5.";

/**
 * Which feed a request asks for. `before` is refused: the feed docs hold the first page only. `hasLiquidity` is 0 or 1
 * and `minPassed` is 0 or 5 (the two flags the indexer stores); anything else is refused with its own sentence. Other
 * parameters are ignored, and a repeated one is read by its first value.
 */
export function radarQuery(sp: URLSearchParams): { ok: true; filter: RadarFeedFilter } | { ok: false; error: string } {
  if (sp.has("before")) return { ok: false, error: BEFORE_ERROR };
  const liquidity = sp.get("hasLiquidity");
  if (liquidity !== null && liquidity !== "0" && liquidity !== "1") return { ok: false, error: LIQUIDITY_ERROR };
  const passed = sp.get("minPassed");
  if (passed !== null && passed !== "0" && passed !== String(RADAR_PASSING_MIN)) return { ok: false, error: PASSED_ERROR };
  return { ok: true, filter: radarFeedFilter({ liquid: liquidity === "1", passing: passed === String(RADAR_PASSING_MIN) }) };
}

const ADDRESS = /^0x[0-9a-f]{40}$/;
/** A uint256 in decimal: at most 78 digits, no sign, no leading zero (except 0 itself). */
const UINT = /^(0|[1-9][0-9]{0,77})$/;
const SOURCES: readonly string[] = ["factory", "v2", "v3", "v4", "aero"] satisfies TokenSource[];
const MAX_CHECKS = 1000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** The millisecond time a stored Timestamp gives, or null when it isn't one. */
function millisOf(value: unknown): number | null {
  if (!isRecord(value) || typeof value.toMillis !== "function") return null;
  const ms: unknown = (value as { toMillis: () => unknown }).toMillis();
  return typeof ms === "number" && Number.isFinite(ms) ? ms : null;
}

function counts(passed: unknown, total: unknown): { passed: number | null; total: number | null } {
  if (
    typeof passed === "number" &&
    typeof total === "number" &&
    Number.isSafeInteger(passed) &&
    Number.isSafeInteger(total) &&
    passed >= 0 &&
    passed <= total &&
    total > 0 &&
    total <= MAX_CHECKS
  ) {
    return { passed, total };
  }
  return { passed: null, total: null };
}

/**
 * A page from what the server read, run once per cache fill. It keeps the stored order (newest first, ties by
 * address) and the first RADAR_FEED_SIZE rows, checking each: a row whose address, source or firstSeen is malformed is
 * skipped and counted, never thrown on; a malformed count, depth or decimals reads as null; labels are cleaned again.
 * The creator is resolved to a launchpad name through `lookup` and never answered itself.
 */
export function radarPage(read: RadarFeedRead, lookup: (creator: string | null) => string | null = launchpadOf): RadarPage {
  const stored: readonly unknown[] = Array.isArray(read.feed?.rows) ? read.feed.rows : [];
  const rows: RadarAnswerRow[] = [];
  let skipped = 0;
  for (const raw of stored.slice(0, RADAR_FEED_SIZE)) {
    const row = (isRecord(raw) ? raw : {}) as Partial<Record<keyof RadarRow, unknown>>;
    const ms = millisOf(row.firstSeen);
    if (typeof row.address !== "string" || !ADDRESS.test(row.address) || typeof row.source !== "string" || !SOURCES.includes(row.source) || ms === null) {
      skipped++;
      continue;
    }
    const decimals = typeof row.decimals === "number" && Number.isInteger(row.decimals) && row.decimals >= 0 && row.decimals <= 36 ? row.decimals : null;
    rows.push({
      address: row.address,
      symbol: typeof row.symbol === "string" ? cleanLabel(row.symbol, 32) : null,
      name: typeof row.name === "string" ? cleanLabel(row.name, 64) : null,
      source: row.source as TokenSource,
      firstSeen: new Date(ms).toISOString(),
      ...counts(row.passed, row.total),
      bestPoolDepth: typeof row.bestPoolDepth === "string" && UINT.test(row.bestPoolDepth) ? row.bestPoolDepth : null,
      decimals,
      launchpad: lookup(typeof row.creator === "string" ? row.creator : null),
    });
  }
  const ranMs = millisOf(read.indexer?.lastRunAt);
  return { rows, indexedAt: ranMs === null ? null : new Date(ranMs).toISOString(), skipped };
}

/** The body the route answers: the page without its count of skipped rows. */
export const radarAnswer = (p: RadarPage): RadarAnswer => ({ rows: p.rows, indexedAt: p.indexedAt });
