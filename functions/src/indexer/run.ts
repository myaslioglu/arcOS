import { Timestamp, type Firestore } from "firebase-admin/firestore";
import type { Address, NetworkId } from "@arcos/chain";
import { v4PoolKeys, type IndexerDoc, type TokenDoc } from "@arcos/data";
import { indexedPools } from "@arcos/data/server";
import type { ExtraPool, PoolScan, Report } from "@arcos/inspector";
import { decodeLogs, sourcesFor } from "./events";
import { afterFailure, expired, pickQueue } from "./queue";
import { bestPoolOf, summarize } from "./report";
import { RangeRefused, type LogChain } from "./rpc";
import {
  finishRun,
  halt,
  loadOrCreateState,
  queueHead,
  recordWindow,
  saveInspection,
  setInspect,
  updateFeeds,
  utcDay,
  writeCursor,
} from "./store";
import { MAX_WINDOW, firstCursor, grow, nextWindow, shrink } from "./windows";

/** The explorer calls one run may still make today, and a way to spend one. */
export type ExplorerBudget = { remaining(): number; spend(): boolean };

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

/** The run's bounds (design 1.3): at most 10 windows, none started after 40 s; inspections none started after 80 s. */
export const LIMITS = { maxWindows: 10, windowsUntilMs: 40_000, inspectUntilMs: 80_000 } as const;

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
  limits?: Partial<typeof LIMITS>;
};

export type RunResult =
  | { status: "paused" }
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
    };

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/** The error's name only: a node's or an explorer's message could carry its URL. */
const nameOf = (e: unknown): string => (e instanceof Error ? e.name : "unknown");

/**
 * One indexer run (design 1.3, "One arcosIndexer run"):
 * 1. reads indexer/{network}, and stops if it is paused or halted;
 * 2. takes the finalized block as head (Arc's finalized is latest or one behind, so there is no reorg to handle);
 * 3. reads new logs in windows of at most 10,000 blocks, one combined eth_getLogs each, halving a refused window;
 *    at most 10 windows read, none started after 40 s; a window that fails ends this phase, and the next run repeats it;
 * 4. records the qualifying pools and their tokens as idempotent upserts, then the cursor, window by window;
 * 5. inspects up to INSPECT_PER_TICK queued tokens, liquid first, then newest, within the explorer budget;
 * 6. rewrites the four Radar feeds when anything changed.
 */
export async function runIndexer(deps: RunDeps): Promise<RunResult> {
  const { db, network, chain, inspectToken, settings } = deps;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? silent;
  const limits = { ...LIMITS, ...deps.limits };
  const started = now();
  const elapsed = () => now() - started;

  // 1. The controls. A missing doc is the first run: it starts 24 hours back.
  let head: number | null = null;
  const readHead = async () => (head ??= await chain.head());
  const state: IndexerDoc = await loadOrCreateState(db, network, async () => firstCursor(await readHead()), started);
  if (state.paused) return { status: "paused" };
  if (state.halted) return { status: "halted", reason: state.halted };

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
      logs = await chain.logs({ addresses, topic0s, from: window.from, to: window.to });
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
      log.warn("arcosIndexer window failed", { from: window.from, to: window.to, error: nameOf(e) });
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

  // 5. The inspection queue.
  const today = utcDay(started);
  let spent = state.explorerCalls.day === today ? state.explorerCalls.count : 0;
  const budget: ExplorerBudget = {
    remaining: () => Math.max(0, settings.explorerDailyBudget - spent),
    spend: () => {
      if (spent >= settings.explorerDailyBudget) return false;
      spent++;
      return true;
    },
  };
  let inspected = 0;
  let failed = 0;
  let expiredCount = 0;
  const perTick = Math.max(0, Math.floor(settings.inspectPerTick));
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
        log.warn("arcosIndexer inspection failed", { error: name, attempts: next.attempts });
      }
    }
  }

  // 6. The Radar feeds.
  const feeds = await updateFeeds(db, network, [...changed.values()], now());
  await finishRun(db, network, now(), { day: today, count: spent });

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
    explorerCalls: spent - (state.explorerCalls.day === today ? state.explorerCalls.count : 0),
  };
}
