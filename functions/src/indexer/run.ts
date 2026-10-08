import { Timestamp, type Firestore } from "firebase-admin/firestore";
import type { Address, NetworkId } from "@arcos/chain";
import { v4PoolKeys, type IndexerDoc, type TokenDoc } from "@arcos/data";
import { indexedPools } from "@arcos/data/server";
import type { ChainReader, ExtraPool, PoolScan, Report } from "@arcos/inspector";
import { errorFields, nameOf } from "./errors";
import { decodeLogs, sourcesFor } from "./events";
import { afterFailure, expired, pickQueue } from "./queue";
import { bestPoolOf, summarize } from "./report";
import { RangeRefused, type LogChain } from "./rpc";
import type { TelegramSender } from "./telegram";
import { runWatch, type WatchResult } from "./watch";
import {
  finishRun,
  halt,
  loadOrCreateState,
  releaseLease,
  queueHead,
  recordWindow,
  saveInspection,
  setInspect,
  updateFeeds,
  utcDay,
  writeCursor,
} from "./store";
import { MAX_WINDOW, firstCursor, grow, nextWindow, shrink } from "./windows";

/**
 * The explorer calls one run may still make today, a way to spend one, and a way to spend the rest at once: the explorer
 * answering 402 means the plan's quota is gone for the day, whatever this side's count says, and asking again only costs
 * the website's share (inspect.ts, `budgetedFetch`).
 */
export type ExplorerBudget = { remaining(): number; spend(): boolean; exhaust(): void };

/** What an inspection gives back: the report, and the pool lookup it was made from (null when that failed). */
export type Inspected = { report: Report; scan: PoolScan | null };

/** Inspects one token. `explorer` is null when the day's explorer budget is spent: the inspection runs on RPC only. */
export type InspectToken = (token: Address, extraPools: ExtraPool[], explorer: ExplorerBudget | null) => Promise<Inspected>;

export type Logger = { info(message: string, data?: object): void; warn(message: string, data?: object): void; error(message: string, data?: object): void };

export type RunSettings = {
  /** INSPECT_PER_TICK: tokens inspected per run (default 3). */
  inspectPerTick: number;
  /** EXPLORER_DAILY_BUDGET: explorer calls per UTC day (default 5,000). */
  explorerDailyBudget: number;
};

/**
 * The run's bounds (design 1.3, and Watchdog's design 4): at most 10 windows, none started after 40 s, and no RPC call
 * of the window phase waited for past 55 s (`windowsDeadlineMs`); the Watchdog step starts only before 55 s, starts no
 * read after 62 s (each at most 5 s, so the reads end by 67 s), starts no fan-out page after 68 s and no send after
 * 72 s (each at most 4 s, so the sends end by 76 s); inspections none started after 80 s, each cut off after 15 s
 * (inspect.ts). So the last inspection ends by about 95 s, and the feeds and the end of the run fit in the function's
 * 120 s. Watchdog never moves the run's end: at worst it narrows the window in which inspections may start.
 */
export const LIMITS = {
  maxWindows: 10,
  windowsUntilMs: 40_000,
  windowsDeadlineMs: 55_000,
  watchStartUntilMs: 55_000,
  watchReadsUntilMs: 62_000,
  watchFanoutUntilMs: 68_000,
  watchSendUntilMs: 72_000,
  inspectUntilMs: 80_000,
} as const;

/**
 * Refused windows one run may halve through. Halving 10,000 reaches one block in 14 steps, and a node with a lower cap costs one refusal a window; more than this means the
 * node refuses whatever it is asked: the indexer halts rather than spin.
 */
const MAX_REFUSALS = 24;

export type RunDeps = {
  db: Firestore;
  network: NetworkId;
  chain: LogChain;
  inspectToken: InspectToken;
  settings: RunSettings;
  now?: () => number;
  log?: Logger;
  /** Overrides of LIMITS, for the tests. */
  limits?: Partial<Record<keyof typeof LIMITS, number>>;
  /**
   * Watchdog's reader and sender (step 4b). Absent, the step is skipped. `telegram` is null when no bot token is
   * configured: the checks and the fan-out still run, and the deliveries wait.
   */
  watch?: { reader: ChainReader; telegram: TelegramSender | null };
};

export type RunResult =
  | { status: "paused" }
  /** Another run's lease is live (`runningUntil`): this one did nothing. */
  | { status: "busy"; until: number }
  | { status: "halted"; reason: string }
  | {
      status: "ran";
      head: number;
      /** The cursor before and after the run. */
      from: number;
      to: number;
      windows: number;
      pools: number;
      tokens: number;
      requeued: number;
      inspected: number;
      failed: number;
      expired: number;
      feeds: number;
      explorerCalls: number;
      /** Watchdog's counters, or null when the step didn't run (no deps, or not mainnet). */
      watch: WatchResult | null;
      /** The name of the error that cut the Watchdog step, the inspections or the feeds short, or null. The run still ended normally. */
      error: string | null;
    };

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * One indexer run (design 1.3, "One arcosIndexer run"):
 * 1. reads indexer/{network} and takes the run's lease, and stops if it is paused or halted, or if another run's lease is
 *    still live;
 * 2. takes the finalized block as head (Arc's finalized is latest or one behind, so there is no reorg to handle);
 * 3. reads new logs in windows of at most 10,000 blocks, one combined eth_getLogs each, halving a refused window;
 *    at most 10 windows read, none started after 40 s; a window that fails ends this phase, and the next run repeats it;
 * 4. records the qualifying pools and their tokens as idempotent upserts, then the cursor, window by window;
 * 4b. (Watchdog, mainnet only, when `deps.watch` is given) checks a page of watched tokens at the tip, writes each
 *    change with its alerts in one batch, fans the alerts out to deliveries, and sends the oldest pending ones to
 *    Telegram, each phase within its own time limit (watch.ts); the page cursor is kept in the run's end (step 6);
 * 5. inspects up to INSPECT_PER_TICK queued tokens, liquid first, then newest, within the explorer budget;
 * 6. brings the four Radar feeds up to date, rebuilding one of them in turn, and ends the run, giving the lease back.
 * Steps 4b, 5 and 6 can't keep the run from ending: an error there is logged and named in the result.
 */
export async function runIndexer(deps: RunDeps): Promise<RunResult> {
  const { db, network } = deps;
  const now = deps.now ?? (() => Date.now());
  const started = now();

  // 1. The controls and the lease. A missing doc is the first run: it starts 24 hours back.
  let head: number | null = null;
  const deadline = started + (deps.limits?.windowsDeadlineMs ?? LIMITS.windowsDeadlineMs);
  const readHead = async () => (head ??= await deps.chain.head(deadline));
  const start = await loadOrCreateState(db, network, async () => firstCursor(await readHead()), started);
  if (start.kind === "busy") return { status: "busy", until: start.until };
  if (start.kind === "stop") return start.state.paused ? { status: "paused" } : { status: "halted", reason: start.state.halted ?? "" };

  let result: RunResult | undefined;
  try {
    result = await leased(deps, start.state, start.runId, readHead, started, deadline);
    return result;
  } finally {
    // A run that ran to the end gave the lease back in finishRun. One that halted or failed before it gives it back
    // here; best effort, since a lease also expires.
    if (result?.status !== "ran") await releaseLease(db, network, start.runId).catch(() => undefined);
  }
}

/** Steps 2 to 6, under this run's lease. */
async function leased(
  deps: RunDeps,
  state: IndexerDoc,
  runId: string,
  readHead: () => Promise<number>,
  started: number,
  deadline: number,
): Promise<RunResult> {
  const { db, network, chain, inspectToken, settings } = deps;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? silent;
  const limits = { ...LIMITS, ...deps.limits };
  const elapsed = () => now() - started;

  // 2. The head.
  const tip = await readHead();

  // 3 and 4. The windows.
  const sources = sourcesFor(network);
  const addresses = sources.map((s) => s.address);
  const topic0s = [...new Set(sources.map((s) => s.topic0))];
  const changed = new Map<string, TokenDoc>();
  let cursor = state.block;
  let span = MAX_WINDOW;
  let windows = 0;
  let refusals = 0;
  let pools = 0;
  let tokens = 0;
  let requeued = 0;
  while (windows < limits.maxWindows && elapsed() < limits.windowsUntilMs) {
    const window = nextWindow(cursor, tip, span);
    if (!window) break;
    let logs;
    try {
      logs = await chain.logs({ addresses, topic0s, from: window.from, to: window.to, deadline });
    } catch (e) {
      if (e instanceof RangeRefused) {
        const width = window.to - window.from + 1;
        if (width === 1 || ++refusals > MAX_REFUSALS) {
          const reason = width === 1 ? `eth_getLogs refused the single block ${window.from}` : `eth_getLogs refused ${refusals} windows in one run, the last from block ${window.from}`;
          await halt(db, network, reason);
          log.error("arcosIndexer halted", { reason });
          return { status: "halted", reason };
        }
        span = shrink(width, e.suggested);
        continue;
      }
      log.warn("arcosIndexer window failed", { from: window.from, to: window.to, ...errorFields(e) });
      break;
    }
    windows++;
    const written = await recordWindow(db, network, decodeLogs(logs, sources), { inspect: state.inspect, now: now() });
    await writeCursor(db, network, window.to, now());
    cursor = window.to;
    span = grow(span);
    pools += written.pools;
    tokens += written.tokens;
    requeued += written.requeued;
    for (const doc of written.changed) changed.set(doc.address, doc);
  }

  // 4b. Watchdog. Its own reader and sender, its own time limits, and no explorer call; whatever fails in it, the
  // inspections and the feeds still run. The cursor rides on finishRun, so a step that threw keeps the last run's.
  let error: string | null = null;
  let watch: WatchResult | null = null;
  if (deps.watch && network === "mainnet") {
    try {
      watch = await runWatch({
        db,
        network,
        tip,
        reader: deps.watch.reader,
        telegram: deps.watch.telegram,
        state,
        now,
        elapsed,
        limits,
        log,
      });
    } catch (e) {
      error ??= nameOf(e);
      log.error("arcosIndexer watch stopped", errorFields(e));
    }
  }

  // 5. The inspection queue.
  const today = utcDay(started);
  const before = state.explorerCalls.day === today ? state.explorerCalls.count : 0;
  let spent = before;
  const budget: ExplorerBudget = {
    remaining: () => Math.max(0, settings.explorerDailyBudget - spent),
    spend: () => {
      if (spent >= settings.explorerDailyBudget) return false;
      spent++;
      return true;
    },
    exhaust: () => {
      spent = Math.max(spent, settings.explorerDailyBudget);
    },
  };
  let inspected = 0;
  let failed = 0;
  let expiredCount = 0;
  const perTick = Math.max(0, Math.floor(settings.inspectPerTick));
  // Whatever fails here (a queue read, a write), the feeds still take what changed and the run still ends with the
  // explorer calls it spent, so the day's budget can't be overrun by runs that failed after spending.
  try {
    if (state.inspect && perTick > 0 && elapsed() < limits.inspectUntilMs) {
      const picked = pickQueue(await queueHead(db, network, perTick * 4), Timestamp.fromMillis(now()), perTick);
      for (const token of picked.expire) {
        await setInspect(db, token, expired(token.inspect));
        expiredCount++;
      }
      for (const token of picked.inspect) {
        if (elapsed() >= limits.inspectUntilMs) break;
        const overBudget = budget.remaining() <= 0;
        try {
          const extra: ExtraPool[] = v4PoolKeys(await indexedPools(db, network, token.address)).map((key) => ({ version: "v4", key }));
          const { report, scan } = await inspectToken(token.address, extra, overBudget ? null : budget);
          const at = now();
          const { summary, radar } = summarize(report, Timestamp.fromMillis(at), tip);
          const next = await saveInspection(db, token, {
            report,
            summary,
            radar,
            bestPool: bestPoolOf(scan),
            degraded: report.degraded || overBudget,
            now: at,
          });
          changed.set(next.address, next);
          inspected++;
        } catch (e) {
          failed++;
          const name = nameOf(e);
          // No contract at the address: asking again won't change that.
          const next = name === "NotAContract" ? { ...expired(token.inspect), attempts: token.inspect.attempts + 1 } : afterFailure(token.inspect);
          await setInspect(db, token, next);
          log.warn("arcosIndexer inspection failed", { ...errorFields(e), attempts: next.attempts });
        }
      }
    }
  } catch (e) {
    error ??= nameOf(e);
    log.error("arcosIndexer inspections stopped", errorFields(e));
  }

  // 6. The Radar feeds, then the end of the run, which gives the lease back.
  let feeds = 0;
  try {
    feeds = await updateFeeds(db, network, [...changed.values()], now());
  } catch (e) {
    error ??= nameOf(e);
    log.error("arcosIndexer feeds failed", errorFields(e));
  }
  await finishRun(db, network, now(), { day: today, calls: spent - before }, runId, watch?.cursor);

  return {
    status: "ran",
    head: tip,
    from: state.block,
    to: cursor,
    windows,
    pools,
    tokens,
    requeued,
    inspected,
    failed,
    expired: expiredCount,
    feeds,
    explorerCalls: spent - before,
    watch,
    error,
  };
}
