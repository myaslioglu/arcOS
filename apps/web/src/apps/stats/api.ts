import { queryOptions } from "@tanstack/react-query";
import { cleanLabel } from "@arcos/inspector";

// The window's side of GET /api/stats: the answer checked field by field (it crossed the network), and the query that
// polls it. Nothing here imports @arcos/data, so the client bundle stays free of the data package.

/** A count as the window shows it. */
export type StatsItem = {
  id: string;
  label: string;
  value: number;
  /** YYYY-MM-DD, or null. */
  since: string | null;
  source: "onchain" | "server";
  parts: { id: string; label: string; value: number }[];
  /** Explorer links to the contracts' logs, https only. */
  links: { label: string; href: string }[];
};

/** The list, with the server's time as it answered (`servedAt`, in ms), which every age is measured against. */
export type StatsList = {
  asOf: { block: number; atMs: number; behind: number } | null;
  items: StatsItem[];
  notes: string[];
  servedAt: number;
};

/** The route answered an error status (`status`), or didn't answer at all or answered something else (null). */
export class StatsFetchError extends Error {
  constructor(readonly status: number | null) {
    super("stats fetch failed");
    this.name = "StatsFetchError";
  }
}

/** A 404: this site keeps no counts (testnet), so there is nothing to poll for. */
export const isGone = (e: unknown): boolean => e instanceof StatsFetchError && e.status === 404;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ITEMS = 24;
const MAX_NOTES = 8;

/** A label made safe to show, or "" when nothing is left of it. */
const clean = (text: string, max: number): string => cleanLabel(text, max) ?? "";

/** A link that is an https URL, or null. */
function httpsLink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/**
 * The route's answer, checked field by field: a count whose id, label, value or source isn't right is dropped, a field
 * that isn't right reads as nothing (a date as no date, a link as no link), and labels are cleaned again. Anything but an
 * answer of version 1 throws. `servedAt` is the server's own time (the `Date` header), or this device's clock (`now`).
 */
export function parseStatsAnswer(json: unknown, servedAt: number = Date.now()): StatsList {
  if (!isRecord(json) || json.version !== 1 || !Array.isArray(json.counts)) throw new StatsFetchError(null);
  const items: StatsItem[] = [];
  const seen = new Set<string>();
  for (const raw of json.counts) {
    if (items.length >= MAX_ITEMS) break;
    if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.label !== "string" || !isCount(raw.value)) continue;
    const label = clean(raw.label, 60);
    if (label === "") continue;
    if (raw.source !== "onchain" && raw.source !== "server") continue;
    if (seen.has(raw.id)) continue;
    seen.add(raw.id);
    const parts = Array.isArray(raw.parts)
      ? raw.parts.flatMap((p: unknown) =>
          isRecord(p) && typeof p.id === "string" && typeof p.label === "string" && isCount(p.value) && clean(p.label, 40) !== "" ? [{ id: p.id, label: clean(p.label, 40), value: p.value }] : [],
        )
      : [];
    const contracts = isRecord(raw.verify) && Array.isArray(raw.verify.contracts) ? raw.verify.contracts : [];
    const links = contracts.flatMap((c: unknown) => {
      const href = isRecord(c) ? httpsLink(c.explorer) : null;
      return isRecord(c) && href && typeof c.label === "string" && clean(c.label, 40) !== "" ? [{ label: clean(c.label, 40), href }] : [];
    });
    items.push({
      id: raw.id,
      label,
      value: raw.value,
      since: typeof raw.since === "string" && DATE.test(raw.since) ? raw.since : null,
      source: raw.source,
      parts,
      links,
    });
  }
  const asOf = isRecord(json.asOf) ? json.asOf : null;
  const atMs = asOf && typeof asOf.at === "string" ? Date.parse(asOf.at) : Number.NaN;
  return {
    asOf: asOf && isCount(asOf.block) && Number.isFinite(atMs) ? { block: asOf.block, atMs, behind: isCount(asOf.behind) ? asOf.behind : 0 } : null,
    items,
    notes: Array.isArray(json.notes) ? json.notes.filter((n): n is string => typeof n === "string").slice(0, MAX_NOTES).map((n) => clean(n, 200)).filter((n) => n !== "") : [],
    servedAt,
  };
}

/** Asks the route for the counts, at most 10 s; an error status, no answer, or a body that isn't one throws StatsFetchError. */
export async function fetchStats(fetchFn: typeof fetch = fetch): Promise<StatsList> {
  let res: Response;
  try {
    res = await fetchFn("/api/stats", { signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new StatsFetchError(null);
  }
  if (!res.ok) throw new StatsFetchError(res.status);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new StatsFetchError(null);
  }
  const date = Date.parse(res.headers.get("date") ?? "");
  return parseStatsAnswer(json, Number.isFinite(date) ? date : Date.now());
}

/**
 * The counts' query: asked on mount, then every 60 s (never again after a 404: the site keeps no counts), and not while
 * the tab is hidden. A failed refresh keeps the last numbers on screen.
 */
export const statsQueryOptions = (enabled: boolean) =>
  queryOptions({
    queryKey: ["stats"],
    queryFn: () => fetchStats(),
    enabled,
    refetchInterval: (q) => (isGone(q.state.error) ? false : 60_000),
    refetchIntervalInBackground: false,
    staleTime: 30_000,
    retry: false,
  });
