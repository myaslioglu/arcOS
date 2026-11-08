import type { Firestore } from "firebase-admin/firestore";
import type { Address, NetworkId } from "@arcos/chain";
import { STATS_FROM } from "@arcos/chain";
import { errorFields, nameOf } from "./errors";
import { RangeRefused, type LogChain } from "./rpc";
import { STATS_EXCLUDED_WALLETS, statsSources } from "./stats";
import { SERVER_COUNT_EVERY_MS, applyStatsWindow, ensureStats, writeServerCounts } from "./stats-store";
import { MAX_WINDOW, grow, nextWindow, shrink } from "./windows";

/**
 * Stats' bounds in a run (step 6b), after the feeds: no window of it starts after `untilMs`, no RPC call is waited for
 * past `deadlineMs` (the inspections end by about 95 s and the run's end needs a few seconds of the function's 120 s), and
 * at most `maxWindows` windows are applied. 20 windows of 10,000 blocks catch up about 2.3 days of chain in a run, so the
 * backfill from the FeeController's deployment (about 750 windows) takes some 40 runs, and a caught-up run applies one.
 */
export type StatsLimits = { untilMs: number; deadlineMs: number; maxWindows: number };
export const STATS_LIMITS: StatsLimits = { untilMs: 100_000, deadlineMs: 108_000, maxWindows: 20 };

/** Refused windows one run may halve through; as in run.ts: more than this means the node refuses whatever it is asked. */
const MAX_REFUSALS = 24;

export type StatsDeps = {
  /** Where counting begins; STATS_FROM[network] unless given (the tests count from a small block). */
  from?: { block: number; at: string };
  /** The wallets left out of the on-chain counts; STATS_EXCLUDED_WALLETS unless given. */
  excluded?: readonly Address[];
  limits?: Partial<StatsLimits>;
  /** How often the server counts are taken again; every 10 minutes unless given. */
  serverEveryMs?: number;
};

/**
 * What the step did, as the run line logs it: counts only, no address. `behind` is how many blocks the cursor is short
 * of the run's head. `error` is the name of what cut the step short, or null.
 */
export type StatsResult = { windows: number; tokensCreated: number; drops: number; behind: number; error: string | null };

type Logger = { warn(message: string, data?: object): void; error(message: string, data?: object): void };

/**
 * The Stats step of a run, within its limits:
 * 1. creates the stats doc on the first run, at the FeeController's deployment block;
 * 2. takes the server counts when the last are 10 minutes old or missing (their failure is named, and the windows go on);
 * 3. reads and applies windows of at most 10,000 blocks from the doc's cursor up to the run's finalized head `tip`, one
 *    eth_getLogs and one transaction each (applyStatsWindow), halving a refused window. A window that can't be read ends
 *    the step; the next run repeats it.
 * Rejects only when the stats doc can't be read or created. The step has a cursor of its own, apart from the indexer's.
 */
export async function runStats(args: {
  db: Firestore;
  network: NetworkId;
  chain: LogChain;
  tip: number;
  /** The run's clock, its start and the elapsed time since. */
  now: () => number;
  started: number;
  elapsed: () => number;
  log: Logger;
  deps: StatsDeps;
}): Promise<StatsResult> {
  const { db, network, chain, tip, now, started, elapsed, log, deps } = args;
  const limits = { ...STATS_LIMITS, ...deps.limits };
  const from = deps.from ?? STATS_FROM[network];
  const sources = statsSources(network);
  const result: StatsResult = { windows: 0, tokensCreated: 0, drops: 0, behind: 0, error: null };
  if (!from || sources.length === 0) return result;

  const doc = await ensureStats(db, network, from, now());
  if (!doc.server || now() - doc.server.countedAt.toMillis() >= (deps.serverEveryMs ?? SERVER_COUNT_EVERY_MS)) {
    try {
      await writeServerCounts(db, network, now());
    } catch (e) {
      result.error ??= nameOf(e);
      log.error("arcosIndexer stats counts failed", errorFields(e));
    }
  }

  const addresses = [...new Set(sources.map((s) => s.address))];
  const topic0s = [...new Set(sources.map((s) => s.topic0))];
  const deadline = started + limits.deadlineMs;
  let cursor = doc.block;
  let span = MAX_WINDOW;
  let refusals = 0;
  // Every pass applies a window, finds one already applied, or follows a cursor another run moved; the bound keeps a
  // cursor that keeps moving from holding the run.
  for (let passes = 0; result.windows < limits.maxWindows && passes < limits.maxWindows * 2 && elapsed() < limits.untilMs; passes++) {
    const window = nextWindow(cursor, tip, span);
    if (!window) break;
    let logs;
    try {
      logs = await chain.logs({ addresses, topic0s, from: window.from, to: window.to, deadline });
    } catch (e) {
      if (e instanceof RangeRefused) {
        const width = window.to - window.from + 1;
        if (width === 1 || ++refusals > MAX_REFUSALS) {
          result.error ??= nameOf(e);
          log.error("arcosIndexer stats window refused", { width, refusals });
          break;
        }
        span = shrink(width, e.suggested);
        continue;
      }
      result.error ??= nameOf(e);
      log.warn("arcosIndexer stats window failed", { from: window.from, to: window.to, ...errorFields(e) });
      break;
    }
    const applied = await applyStatsWindow(db, network, window, logs, { sources, tip, now: now(), excluded: deps.excluded ?? STATS_EXCLUDED_WALLETS });
    if (applied.kind === "missing") {
      result.error ??= "StatsMissing";
      log.error("arcosIndexer stats doc missing");
      break;
    }
    if (applied.kind === "applied") {
      result.windows++;
      result.tokensCreated += applied.delta.tokensCreated;
      result.drops += applied.delta.drops;
      span = grow(span);
    }
    cursor = applied.block;
  }
  result.behind = Math.max(0, tip - cursor);
  return result;
}
