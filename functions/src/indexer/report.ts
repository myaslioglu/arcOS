import { RADAR_PASSING_MIN, type ReportSummary, type TimestampLike, type TokenDoc } from "@arcos/data";
import { bestPool, type PoolScan, type Report } from "@arcos/inspector";

/**
 * What a token doc keeps of a report: the summary, and Radar's two stored flags. `liquid` is the liquidity check
 * passing (at least 1,000 USDC, the Inspector's MIN_DEPTH); `passing` is at least five checks passing (design 1.6).
 * `block` is the report's block, or `fallbackBlock` when the report couldn't read one.
 */
export function summarize(report: Report, at: TimestampLike, fallbackBlock: number): { summary: ReportSummary; radar: TokenDoc["radar"] } {
  const block = /^\d+$/.test(report.blockNumber) ? Number(report.blockNumber) : fallbackBlock;
  return {
    summary: {
      passed: report.passed,
      total: report.total,
      counts: { pass: report.counts.pass, warn: report.counts.warn, fail: report.counts.fail, unknown: report.counts.unknown },
      block,
      at,
    },
    radar: {
      liquid: report.findings.some((f) => f.id === "liquidity" && f.status === "pass"),
      passing: report.passed >= RADAR_PASSING_MIN,
    },
  };
}

/**
 * The token's best pool from the inspection's own pool lookup: the one its liquidity finding names. A v4 pool is named by
 * its pool id (its `address` is the PoolManager's), the others by address. Null when the lookup found none; undefined
 * when it failed, so the stored one stays.
 */
export function bestPoolOf(scan: PoolScan | null): TokenDoc["bestPool"] | undefined {
  if (scan === null) return undefined;
  if (scan.pools.length === 0) return null;
  const pool = bestPool(scan.pools);
  return { id: (pool.poolId ?? pool.address).toLowerCase(), version: pool.version, depthUsdc: pool.depth.toString() };
}
