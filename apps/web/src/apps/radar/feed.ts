import { queryOptions } from "@tanstack/react-query";
import { cleanLabel } from "@arcos/inspector";
import type { RadarAnswerRow } from "@/lib/radar";

// The window's side of GET /api/radar: which feed the two filters name, the answer checked field by field (it crossed
// the network), and the query that polls it. Nothing here imports @arcos/data: the filter mapping is four lines, kept
// here and tested, so the client bundle stays free of the data package.

export type RadarFilters = { liquid: boolean; passing: boolean };

/** A row as the window shows it: the answer's row, with `firstSeen` parsed once. */
export type RadarItem = Omit<RadarAnswerRow, "firstSeen"> & { firstSeen: string; firstSeenMs: number };

/** The list, with the index's last run and the server's time as it answered (`servedAt`), both in milliseconds. */
export type RadarList = { rows: RadarItem[]; indexedAt: number | null; servedAt: number };

/** The feed the filters name: the same mapping as the data package's radarFeedFilter. */
export function radarKey(f: RadarFilters): "all" | "liquid" | "passing" | "liquid-passing" {
  if (f.liquid && f.passing) return "liquid-passing";
  if (f.liquid) return "liquid";
  return f.passing ? "passing" : "all";
}

export function radarUrl(f: RadarFilters): string {
  const sp = new URLSearchParams();
  if (f.liquid) sp.set("hasLiquidity", "1");
  if (f.passing) sp.set("minPassed", "5");
  const query = sp.toString();
  return query ? `/api/radar?${query}` : "/api/radar";
}

/** The route answered an error status (`status`), or didn't answer at all or answered something else (null). */
export class RadarFetchError extends Error {
  constructor(readonly status: number | null) {
    super("radar fetch failed");
    this.name = "RadarFetchError";
  }
}

/** A 404: this site has no token index (testnet), so there is nothing to poll for. */
export const isGone = (e: unknown): boolean => e instanceof RadarFetchError && e.status === 404;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^(0|[1-9][0-9]{0,77})$/;
const SOURCES: readonly string[] = ["factory", "v2", "v3", "v4", "aero"];
const PAGE = 50;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/**
 * The route's answer, checked field by field: a row whose address, source or time isn't right, or whose address a row
 * before it has, is dropped; a field that isn't right reads as null, and labels are cleaned again. At most one page.
 * Anything but an answer throws. A `servedAt` that isn't a time reads as this device's clock (`now`).
 */
export function parseRadarAnswer(json: unknown, now: () => number = Date.now): RadarList {
  if (!isRecord(json) || !Array.isArray(json.rows) || !(typeof json.indexedAt === "string" || json.indexedAt === null)) {
    throw new RadarFetchError(null);
  }
  const rows: RadarItem[] = [];
  const seen = new Set<string>();
  for (const raw of json.rows) {
    if (rows.length >= PAGE) break;
    if (!isRecord(raw)) continue;
    if (typeof raw.address !== "string" || !ADDRESS.test(raw.address)) continue;
    if (typeof raw.source !== "string" || !SOURCES.includes(raw.source)) continue;
    const firstSeenMs = typeof raw.firstSeen === "string" ? Date.parse(raw.firstSeen) : Number.NaN;
    if (!Number.isFinite(firstSeenMs)) continue;
    const address = raw.address.toLowerCase();
    // Each address is one list item, keyed by it: a repeat is dropped.
    if (seen.has(address)) continue;
    seen.add(address);
    const counted = isCount(raw.passed) && isCount(raw.total);
    rows.push({
      address,
      symbol: typeof raw.symbol === "string" ? cleanLabel(raw.symbol, 32) : null,
      name: typeof raw.name === "string" ? cleanLabel(raw.name, 64) : null,
      source: raw.source as RadarItem["source"],
      firstSeen: raw.firstSeen as string,
      firstSeenMs,
      passed: counted ? (raw.passed as number) : null,
      total: counted ? (raw.total as number) : null,
      bestPoolDepth: typeof raw.bestPoolDepth === "string" && UINT.test(raw.bestPoolDepth) ? raw.bestPoolDepth : null,
      decimals: isCount(raw.decimals) && raw.decimals >= 0 && raw.decimals <= 36 ? raw.decimals : null,
      launchpad: typeof raw.launchpad === "string" ? cleanLabel(raw.launchpad, 24) : null,
    });
  }
  const indexedAt = json.indexedAt === null ? Number.NaN : Date.parse(json.indexedAt);
  const servedAt = typeof json.servedAt === "string" ? Date.parse(json.servedAt) : Number.NaN;
  return { rows, indexedAt: Number.isFinite(indexedAt) ? indexedAt : null, servedAt: Number.isFinite(servedAt) ? servedAt : now() };
}

/** Asks the route for the feed, at most 10 s; an error status, no answer, or a body that isn't one throws RadarFetchError. */
export async function fetchRadar(f: RadarFilters, fetchFn: typeof fetch = fetch): Promise<RadarList> {
  let res: Response;
  try {
    res = await fetchFn(radarUrl(f), { signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new RadarFetchError(null);
  }
  if (!res.ok) throw new RadarFetchError(res.status);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new RadarFetchError(null);
  }
  return parseRadarAnswer(json);
}

/**
 * The list's query, one per feed: asked on mount, then every 20 s (every 60 s after an error, never again after a
 * 404: the site has no index), and not while the tab is hidden. A failed refresh keeps the last list on screen.
 */
export const radarQueryOptions = (f: RadarFilters, enabled: boolean) =>
  queryOptions({
    queryKey: ["radar", radarKey(f)],
    queryFn: () => fetchRadar(f),
    enabled,
    refetchInterval: (q) => (isGone(q.state.error) ? false : q.state.status === "error" ? 60_000 : 20_000),
    refetchIntervalInBackground: false,
    staleTime: 20_000,
    retry: false,
  });
