import type { Report } from "@arcos/inspector";

const CLEAN_S = 300;
const DEGRADED_S = 30;

/**
 * How many seconds a report stays fresh: in this server's own cache (inspect-server.ts) and at the CDN (`s-maxage` on
 * /api/inspect, /badge and the OG image). A degraded report — some read failed at the transport level, so some of its
 * unknowns may only be a network hiccup — is kept 30 seconds instead of 5 minutes.
 */
export const reportMaxAge = (report: Pick<Report, "degraded">): number => (report.degraded ? DEGRADED_S : CLEAN_S);

/**
 * `cache-control` for a response rendered from a report. A degraded one gets no stale-while-revalidate: once its 30
 * seconds are up, the next visitor waits for a fresh reading instead of being served the degraded one again. `null` is
 * "nothing to inspect" (not an address), which won't change either, so it is kept like a clean report.
 */
export function reportCacheControl(report: Pick<Report, "degraded"> | null): string {
  return report?.degraded ? `public, s-maxage=${DEGRADED_S}` : `public, s-maxage=${CLEAN_S}, stale-while-revalidate=600`;
}

/** An inspection that failed outright (busy instance, network error, no contract) still gets a neutral badge or card,
 * kept 5 seconds, so it recovers as soon as the instance can inspect again. */
export const FAILED_INSPECTION_CACHE_CONTROL = "public, s-maxage=5";
