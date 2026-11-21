import type { Firestore } from "firebase-admin/firestore";
import { DEX, UNISWAP_V4_FROM, type NetworkId } from "@arcos/chain";
import { MODIFY_LIQUIDITY_TOPIC } from "@arcos/inspector";
import { errorFields, nameOf } from "./errors";
import { TOPICS } from "./events";
import { applyPositionsWindow, clearPositionsAttempt, decodePoolLogs, decodePositionLogs, ensurePositionsIndex, markPositionsAttempt, storePositionsSpan } from "./positions-store";
import { DeadlineExceeded, RangeRefused, type LogChain } from "./rpc";
import { MAX_WINDOW, grow, nextWindow, shrink } from "./windows";

/**
 * The position index's bounds in a run (step 6c), after Stats: no window of it starts after `untilMs`, no RPC call is
 * waited for past `deadlineMs`, no round of a window's writes starts past `writeUntilMs`, at most `maxWindows` windows
 * are applied, and none starts more than `stepMs` after the step began.
 *
 * The function is killed at 120 s, and a killed run stores nothing of what it was doing. So the step keeps well clear:
 * it starts a window only before 90 s, waits for no RPC answer past 96 s and starts no round of writes past 100 s. A
 * round is six chunks of 400 docs, each a read and a batch: one to three seconds as a rule, and on the function's
 * third of a CPU, with a dense window's 12 MB of logs just parsed, it has been seen to take far longer. 20 s is what
 * is left for the last round, the cursor's transaction and the run's own end. The price is that a run whose
 * inspections go on past 90 s gives this step nothing that minute.
 *
 * A caught-up run reads one window (about 120 blocks). The backfill from the PoolManager's deployment (mainnet block
 * 1,948,056; about 3,030 windows of 10,000 blocks on 2026-11-20) takes a few hundred runs: a window is one
 * eth_getLogs, 400 ms after the last call, and its writes. A sparse window is done in about a second, so a run fits
 * about 8 into its 10 s; a dense one (the densest has 19,996 logs and 7,678 new pools) takes far longer than a run
 * can give it. Three things make a window too large for a run narrower the next time, down to one block, with the
 * width stored on the cursor doc and the cursor where it was:
 * - `unfinished`: its docs weren't all stored when the time for writes ran out;
 * - its logs didn't arrive in time;
 * - the run was killed on it. Nothing can be stored then, so the window is written down BEFORE it is read (the attempt
 *   marker, `attempt`), and a run that finds the marker still on the block after the cursor halves that width.
 * Each also sets a ceiling at the halved width, which holds until the cursor has passed the window that was too
 * large: the width doubles with every window applied, but not back into what just failed.
 */
export type PositionsLimits = { untilMs: number; deadlineMs: number; writeUntilMs: number; maxWindows: number; stepMs: number };
export const POSITIONS_LIMITS: PositionsLimits = { untilMs: 90_000, deadlineMs: 96_000, writeUntilMs: 100_000, maxWindows: 12, stepMs: 10_000 };

/** Refused windows one run may halve through; as in run.ts: more than this means the node refuses whatever it is asked. */
const MAX_REFUSALS = 24;

export type PositionsDeps = {
  /** Where the index begins; UNISWAP_V4_FROM[network] unless given (the tests start from a small block). */
  fromBlock?: number;
  limits?: Partial<PositionsLimits>;
  /** Called once the attempt marker of a window is stored, before the window is read. The tests kill the run here. */
  onAttempt?: (attempt: { from: number; width: number }) => void | Promise<void>;
};

/**
 * What the step did, as the run line logs it: counts only, no address. `positions` is how many new positions were stored
 * and `pools` how many pool docs it added; `behind` is how many blocks the cursor is short of the run's head. `error` is the
 * name of what cut the step short, or null.
 */
export type PositionsResult = { windows: number; positions: number; pools: number; behind: number; error: string | null };

type Logger = { warn(message: string, data?: object): void; error(message: string, data?: object): void };

/**
 * The position index's step of a run, within its limits:
 * 1. creates the cursor doc on the first run, at the PoolManager's deployment block;
 * 2. reads the PoolManager's `ModifyLiquidity` and `Initialize` logs in windows of at most 10,000 blocks from the cursor
 *    up to `indexed`, the main indexer's cursor (never past it: see applyPositionsWindow), which is the run's finalized
 *    head `tip` unless the main indexer is behind; one eth_getLogs each, halving a refused window; and stores each
 *    window's positions and pools and then the cursor (applyPositionsWindow). A window that can't be read or stored
 *    ends the step; the next run repeats it.
 * Every `ModifyLiquidity` is recorded, whatever the pool, and every v4 pool the pool index keeps gets its doc in pools/
 * if it has none: a pool older than the main indexer's first block isn't there, and a hooked or odd-fee one is found
 * by an inspection only through it. So pools and positions are complete together up to this step's cursor. Rejects
 * only when the cursor doc can't be read or created.
 */
export async function runPositions(args: {
  db: Firestore;
  network: NetworkId;
  chain: LogChain;
  tip: number;
  /** The main indexer's cursor after this run's windows: the last block whose pools it has recorded. */
  indexed: number;
  /** The run's clock, its start and the elapsed time since. */
  now: () => number;
  started: number;
  elapsed: () => number;
  log: Logger;
  deps: PositionsDeps;
}): Promise<PositionsResult> {
  const { db, network, chain, tip, now, started, elapsed, log, deps } = args;
  const limits = { ...POSITIONS_LIMITS, ...deps.limits };
  const fromBlock = deps.fromBlock ?? UNISWAP_V4_FROM[network];
  const poolManager = DEX[network]?.v4?.poolManager;
  const result: PositionsResult = { windows: 0, positions: 0, pools: 0, behind: 0, error: null };
  const until = Math.min(tip, args.indexed);
  if (fromBlock === null || fromBlock === undefined || !poolManager || elapsed() >= limits.untilMs) return result;
  const stepStarted = elapsed();

  const doc = await ensurePositionsIndex(db, network, fromBlock, now(), tip);
  const deadline = started + limits.deadlineMs;
  let cursor = doc.block;
  // The width the last stored window was read with: a stretch of dense blocks isn't found out again from the cap each run.
  let span = typeof doc.span === "number" && doc.span >= 1 ? Math.min(MAX_WINDOW, Math.floor(doc.span)) : MAX_WINDOW;
  // The ceiling a window that was too large left behind, in force until the cursor has passed that window.
  let cap = typeof doc.ceiling === "number" && doc.ceiling >= 1 ? Math.floor(doc.ceiling) : MAX_WINDOW;
  let capUntil = typeof doc.ceilingUntil === "number" ? doc.ceilingUntil : -1;
  const capped = () => (cursor < capUntil ? cap : MAX_WINDOW);
  let refusals = 0;
  // Once the node has refused a width in this run, no window is tried that wide again.
  let ceiling = MAX_WINDOW;
  /**
   * The window was too much (its logs didn't arrive, its docs weren't all stored, or the run died on it): the next
   * window is half its width, stored with the cursor, which stays where it is, and nothing wider is read until the
   * cursor is past it. Without this a run would take on the same dense window every minute, for ever.
   */
  const narrow = async (window: { from: number; to: number }): Promise<number> => {
    const width = window.to - window.from + 1;
    const next = shrink(width);
    try {
      await storePositionsSpan(db, network, next, window.to);
    } catch (e) {
      log.warn("arcosIndexer positions span not stored", errorFields(e));
    }
    return next;
  };
  // The last run's attempt is still on the block after the cursor: it never finished and never said why. It was killed.
  const died = doc.attempt;
  if (died && typeof died.from === "number" && typeof died.width === "number" && died.width >= 1 && died.from === cursor + 1) {
    log.warn("arcosIndexer positions attempt died", { from: died.from, width: died.width });
    const half = await narrow({ from: died.from, to: died.from + Math.floor(died.width) - 1 });
    span = Math.min(span, half);
    cap = half;
    capUntil = Math.max(capUntil, died.from + Math.floor(died.width) - 1);
  }
  span = Math.min(span, capped());
  const forget = async () => {
    try {
      await clearPositionsAttempt(db, network);
    } catch (e) {
      log.warn("arcosIndexer positions attempt not cleared", errorFields(e));
    }
  };
  // Every pass applies a window, finds one already applied, or follows a cursor another run moved; the bound keeps a
  // cursor that keeps moving from holding the run.
  for (let passes = 0; result.windows < limits.maxWindows && passes < limits.maxWindows * 2 && elapsed() < limits.untilMs && elapsed() - stepStarted < limits.stepMs; passes++) {
    const window = nextWindow(cursor, until, span);
    if (!window) break;
    // Written down before it is read: see `PositionsLimits`. A marker that can't be written stops the step, since a
    // window read without one could kill every run from here on and leave no trace.
    const attempt = { from: window.from, width: window.to - window.from + 1 };
    try {
      await markPositionsAttempt(db, network, { ...attempt, at: now() });
    } catch (e) {
      result.error ??= nameOf(e);
      log.error("arcosIndexer positions attempt not stored", errorFields(e));
      break;
    }
    await deps.onAttempt?.(attempt);
    let logs;
    try {
      logs = await chain.logs({ addresses: [poolManager], topic0s: [MODIFY_LIQUIDITY_TOPIC, TOPICS.initialize], from: window.from, to: window.to, deadline });
    } catch (e) {
      if (e instanceof RangeRefused) {
        const width = window.to - window.from + 1;
        if (width === 1 || ++refusals > MAX_REFUSALS) {
          result.error ??= nameOf(e);
          log.error("arcosIndexer positions window refused", { width, refusals });
          await forget();
          break;
        }
        // The node's own hint when it gives one ("retry with the range A-B": 9,473 blocks, say), else half.
        span = e.suggested !== undefined && e.suggested >= 1 && e.suggested < width ? e.suggested : shrink(width);
        ceiling = Math.min(ceiling, span);
        continue;
      }
      result.error ??= nameOf(e);
      log.warn("arcosIndexer positions window failed", { from: window.from, to: window.to, ...errorFields(e) });
      // Out of time, here or at the node: a narrower window answers sooner.
      if (e instanceof DeadlineExceeded || /timeout|timed out/i.test(`${nameOf(e)} ${e instanceof Error ? e.message : ""}`)) await narrow(window);
      else await forget();
      break;
    }
    let applied;
    try {
      applied = await applyPositionsWindow(db, network, window, decodePositionLogs(logs, poolManager, window), {
        tip, now: now(), pools: decodePoolLogs(logs, network, window), until: started + limits.writeUntilMs, clock: now, span,
      });
    } catch (e) {
      result.error ??= nameOf(e);
      log.error("arcosIndexer positions window not applied", { from: window.from, to: window.to, ...errorFields(e) });
      await forget();
      break;
    }
    if (applied.kind === "missing") {
      result.error ??= "PositionsIndexMissing";
      log.error("arcosIndexer positions cursor missing");
      break;
    }
    if (applied.kind === "unfinished") {
      // Not an error: the window is larger than what was left of the run. Its docs so far are stored, and the next run
      // reads half as wide a window, which has that much less to store and to check.
      result.positions += applied.written;
      result.pools += applied.pools;
      log.warn("arcosIndexer positions window unfinished", { from: window.from, to: window.to, positions: applied.written, pools: applied.pools });
      await narrow(window);
      break;
    }
    if (applied.kind === "applied") {
      result.windows++;
      result.positions += applied.written;
      result.pools += applied.pools;
      cursor = applied.block;
      span = Math.min(grow(span), ceiling, capped());
      continue;
    }
    // Already applied, or moved by another run: this attempt is nobody's unfinished business.
    await forget();
    cursor = applied.block;
  }
  result.behind = Math.max(0, tip - cursor);
  return result;
}
