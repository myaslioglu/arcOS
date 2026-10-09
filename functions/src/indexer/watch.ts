import { Timestamp, type Firestore } from "firebase-admin/firestore";
import type { Address, NetworkId } from "@arcos/chain";
import {
  DELIVERY_MAX_AGE_MS,
  DELIVERY_MAX_ATTEMPTS,
  alertText,
  diffWatchState,
  nextWatchState,
  seen,
  watchStateFromDoc,
  type DeliveryDoc,
  type DeliveryError,
  type IndexerDoc,
} from "@arcos/data";
import type { ChainReader } from "@arcos/inspector";
import { errorFields } from "./errors";
import type { Logger } from "./run";
import { UNAUTHORIZED_PAUSE_MS, type SendOutcome, type TelegramSender } from "./telegram";
import { readWatchToken, type WatchReadInput } from "./watch-read";
import {
  commitCheck,
  deliveryContext,
  fanoutAlert,
  healState,
  markDelivery,
  pendingDeliveries,
  pendingFanout,
  tokenContext,
  unlinkChatIfSame,
  watchPage,
  type DeliveryRow,
  type FanoutBudget,
  type TokenContext,
} from "./watch-store";

// Watchdog's step of a run (design 3.4), step 4b of run.ts, in three phases that each stop at their own time limit and
// resume next minute: A checks a page of watched tokens against the chain at the run's tip and writes what changed with
// its alerts; B creates the deliveries of alerts not yet fanned out; C sends the oldest pending deliveries to Telegram.
// Nothing here logs an address, a chat id, a message or a token: names, codes and counts only.

/** The step's caps. `caps` in the deps overrides them, for the tests. */
export const WATCH = {
  /** Tokens checked a run: 40 × 3 RPC requests. Each of N watched tokens is checked every ceil(N / 40) minutes. */
  tokensPerRun: 40,
  readConcurrency: 4,
  /** Delivery docs one run may create. */
  fanoutPerRun: 1_000,
  /** Alerts whose fan-out one run picks up. */
  fanoutAlertsPerRun: 10,
  /** Pending deliveries one run reads. */
  deliveriesPerRun: 100,
  sendsPerRun: 60,
  sendConcurrency: 4,
  perChatPerRun: 3,
  /** Consecutive transport or timeout failures that stop the run's remaining reads: the endpoints are down, not the token. */
  breaker: 3,
  /** Lines of one kind a run logs before it says `suppressed`. */
  logCap: 5,
} as const;

/** The step's time limits, on the run's clock (`elapsed`). See LIMITS in run.ts. */
export type WatchLimits = { watchStartUntilMs: number; watchReadsUntilMs: number; watchFanoutUntilMs: number; watchSendUntilMs: number };

/** Until when this instance makes no send: set by a 429 (for the seconds asked) or a 401/404 (UNAUTHORIZED_PAUSE_MS). */
export type TelegramPause = { until: number };
/** The instance's own pause, kept across runs. */
export const instancePause: TelegramPause = { until: 0 };

export type WatchDeps = {
  db: Firestore;
  network: NetworkId;
  /** The run's finalized head: every read is pinned to it, and alerts report it. */
  tip: number;
  reader: ChainReader;
  /** Null when no bot token is configured: phase C is skipped. */
  telegram: TelegramSender | null;
  state: IndexerDoc;
  now: () => number;
  elapsed: () => number;
  limits: WatchLimits;
  log: Logger;
  pause?: TelegramPause;
  caps?: Partial<Record<keyof typeof WATCH, number>>;
};

export type WatchResult = {
  /** Tokens whose read was attempted. */
  checked: number;
  /** Of those, reads that left some field unread. */
  unread: number;
  /** Checks that failed on the Firestore side (the token is read again next time). */
  failed: number;
  alerts: number;
  /** watchState docs written. */
  writes: number;
  deliveriesCreated: number;
  /** Alerts whose fan-out finished this run. */
  fannedOut: number;
  sent: number;
  /** Sends that failed, and deliveries failed without a send (expired, unlinked, no alert). */
  sendFailed: number;
  skipped: "off" | "late" | null;
  /** The watchState doc id the run's checks ended at, for the next run's page. */
  cursor: string | null;
};

/** What the Telegram message of an alert says: the words, then the explorer link. Plain text, within Telegram's 4,096 characters. */
export const MESSAGE_MAX_CHARS = 4_096;
export const alertMessage = (text: string, link: string): string => [...`${text} — ${link}`].slice(0, MESSAGE_MAX_CHARS).join("");

/** What a send's outcome does to its delivery: an update, or none when the outcome pauses sends instead. */
export type DeliveryStep =
  | { update: Partial<DeliveryDoc>; unlink: boolean; pauseMs: null }
  | { update: null; unlink: false; pauseMs: number };

/**
 * The delivery after one send, pure: sent on ok; one more attempt and the code on a retryable failure, failed once the
 * attempts reach DELIVERY_MAX_ATTEMPTS; failed at once, and the chat unlinked, when the chat blocked the bot or is gone;
 * failed at once on a refused message; and untouched (no attempt counted) when Telegram rate-limited the bot or refused
 * its token, which pauses sends instead.
 */
export function nextDelivery(delivery: Pick<DeliveryDoc, "attempts">, outcome: SendOutcome, now: number): DeliveryStep {
  const attempts = delivery.attempts + 1;
  switch (outcome.kind) {
    case "ok":
      return { update: { status: "sent", attempts, error: null, deliveredAt: Timestamp.fromMillis(now) }, unlink: false, pauseMs: null };
    case "telegram_5xx":
    case "timeout":
    case "network":
      return { update: { status: attempts >= DELIVERY_MAX_ATTEMPTS ? "failed" : "pending", attempts, error: outcome.kind }, unlink: false, pauseMs: null };
    case "blocked":
    case "chat_not_found":
      return { update: { status: "failed", attempts, error: outcome.kind }, unlink: true, pauseMs: null };
    case "bad_request":
      return { update: { status: "failed", attempts, error: "bad_request" }, unlink: false, pauseMs: null };
    case "rate_limited":
      return { update: null, unlink: false, pauseMs: outcome.retryAfterSec * 1_000 };
    case "unauthorized":
      return { update: null, unlink: false, pauseMs: UNAUTHORIZED_PAUSE_MS };
  }
}

/** A log line of one kind at most `cap` times a run, then one line saying the rest were suppressed. */
function capped(log: Logger, cap: number): (level: "warn" | "error", message: string, data: object) => void {
  const counts = new Map<string, number>();
  return (level, message, data) => {
    const count = (counts.get(message) ?? 0) + 1;
    counts.set(message, count);
    if (count <= cap) log[level](message, data);
    else if (count === cap + 1) log[level](message, { suppressed: true });
  };
}

/** What the reader is asked for a token: its deepest pool as the index knows it, and the index's label as the fallback. */
function readInput(network: NetworkId, token: Address, context: TokenContext): WatchReadInput {
  const { token: doc, pool } = context;
  return {
    network,
    token,
    pool: doc?.bestPool && pool ? { id: pool.poolId, version: pool.version, quote: pool.quote, key: pool.key } : null,
    label: { symbol: doc?.symbol ?? null, decimals: doc?.decimals ?? null },
  };
}

/** Runs `count` workers over `work` until each returns, then rethrows the first failure once all have stopped. */
async function workers(count: number, work: () => Promise<void>): Promise<void> {
  const settled = await Promise.allSettled(Array.from({ length: count }, work));
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
  if (failed) throw failed.reason;
}

type Planned = { delivery: DeliveryRow; chatId: number; text: string };

/** Watchdog's step. Rejects only when Firestore fails outright; a token's own failure is counted and logged. */
export async function runWatch(deps: WatchDeps): Promise<WatchResult> {
  const { db, network, tip, reader, telegram, state, now, elapsed, limits } = deps;
  const caps = { ...WATCH, ...deps.caps };
  const log = capped(deps.log, caps.logCap);
  const result: WatchResult = {
    checked: 0, unread: 0, failed: 0, alerts: 0, writes: 0, deliveriesCreated: 0, fannedOut: 0, sent: 0, sendFailed: 0, skipped: null, cursor: state.watchCursor ?? null,
  };
  if (state.watch === false) return { ...result, skipped: "off" };
  if (elapsed() >= limits.watchStartUntilMs) return { ...result, skipped: "late" };

  // A. The checks: a page of watched tokens after the last run's cursor, read a few at a time against the tip.
  const page = await watchPage(db, network, result.cursor, caps.tokensPerRun);
  const context = await tokenContext(db, network, page.map((row) => row.doc.token));
  let next = 0;
  let lastAttempted = -1;
  let consecutive = 0;
  let tripped = false;
  await workers(caps.readConcurrency, async () => {
    while (!tripped && next < page.length && elapsed() < limits.watchReadsUntilMs) {
      const i = next++;
      const row = page[i]!;
      lastAttempted = Math.max(lastAttempted, i);
      try {
        if (!(row.doc.watchers > 0)) {
          await healState(db, row);
          continue;
        }
        result.checked++;
        const { observation, failure } = await readWatchToken(reader, readInput(network, row.doc.token, context.get(row.doc.token) ?? { token: null, pool: null }), tip);
        if (failure === "transport" || failure === "timeout") {
          if (++consecutive >= caps.breaker && !tripped) {
            tripped = true;
            deps.log.warn("arcosIndexer watch reads stopped", { code: "breaker" });
          }
        } else {
          consecutive = 0;
        }
        if (failure !== null) log("warn", "arcosIndexer watch read failed", { code: failure });
        const fields = [observation.owner, observation.totalSupply, observation.paused, observation.implementation, observation.pool];
        if (fields.some((f) => !f.ok)) result.unread++;
        const prev = seen(row.doc) ? watchStateFromDoc(row.doc) : null;
        const drafts = diffWatchState(prev, observation);
        const patch = nextWatchState(prev, observation, Timestamp.fromMillis(now()));
        const committed = await commitCheck(db, row, patch, drafts, now());
        if (committed.written) {
          result.writes++;
          result.alerts += committed.alerts;
        }
      } catch (e) {
        // A doc this code can't read, or a write refused: the token is read again on its next turn.
        result.failed++;
        log("warn", "arcosIndexer watch check failed", errorFields(e));
      }
    }
  });
  if (lastAttempted >= 0) result.cursor = page[lastAttempted]!.id;

  // B. The fan-out: deliveries for every alert not yet fanned out, within the run's budget of creates.
  if (elapsed() < limits.watchFanoutUntilMs) {
    let remaining: number = caps.fanoutPerRun;
    const budget: FanoutBudget = { remaining: () => remaining, spend: (n) => void (remaining -= n), late: () => elapsed() >= limits.watchFanoutUntilMs };
    for (const alert of await pendingFanout(db, network, caps.fanoutAlertsPerRun)) {
      if (budget.late() || remaining <= 0) break;
      const fanned = await fanoutAlert(db, alert, budget, now());
      result.deliveriesCreated += fanned.created;
      if (fanned.done) result.fannedOut++;
    }
  }

  // C. The sends: the oldest pending deliveries, a few chats at a time, each chat's in sequence.
  const pause = deps.pause ?? instancePause;
  if (state.telegram === false || telegram === null || pause.until > now() || elapsed() >= limits.watchSendUntilMs) return result;
  const deliveries = await pendingDeliveries(db, caps.deliveriesPerRun);
  if (deliveries.length === 0) return result;
  const { users, alerts } = await deliveryContext(db, deliveries);
  const byChat = new Map<number, Planned[]>();
  let planned = 0;
  for (const delivery of deliveries) {
    const user = users.get(delivery.doc.user) ?? null;
    const alert = alerts.get(delivery.doc.alertId) ?? null;
    const dead: DeliveryError | null =
      now() - delivery.doc.createdAt.toMillis() >= DELIVERY_MAX_AGE_MS ? "expired" : user?.telegram == null ? "unlinked" : alert === null ? "no_alert" : null;
    if (dead !== null) {
      await markDelivery(delivery, { status: "failed", error: dead });
      result.sendFailed++;
      continue;
    }
    const chatId = user!.telegram!.chatId;
    const list = byChat.get(chatId) ?? [];
    if (list.length >= caps.perChatPerRun || planned >= caps.sendsPerRun) continue;
    const { text, link } = alertText({ kind: alert!.kind, token: alert!.token, network: alert!.network, block: alert!.block, detail: alert!.detail });
    list.push({ delivery, chatId, text: alertMessage(text, link) });
    byChat.set(chatId, list);
    planned++;
  }
  const chats = [...byChat.values()];
  let nextChat = 0;
  let paused = false;
  await workers(caps.sendConcurrency, async () => {
    while (!paused && nextChat < chats.length) {
      for (const { delivery, chatId, text } of chats[nextChat++]!) {
        if (paused || elapsed() >= limits.watchSendUntilMs) return;
        // Send first, then mark: a run that dies between the two sends once more rather than never.
        const outcome = await telegram.send(chatId, text);
        const step = nextDelivery(delivery.doc, outcome, now());
        if (step.update === null) {
          paused = true;
          pause.until = Math.max(pause.until, now() + step.pauseMs);
          deps.log.warn("arcosIndexer telegram paused", { code: outcome.kind, seconds: Math.round(step.pauseMs / 1_000) });
          return;
        }
        await markDelivery(delivery, step.update);
        if (outcome.kind === "ok") {
          result.sent++;
        } else {
          result.sendFailed++;
          log("warn", "arcosIndexer telegram send failed", { code: outcome.kind, ...(outcome.kind === "telegram_5xx" ? { status: outcome.status } : {}), attempts: step.update.attempts });
        }
        if (step.unlink) await unlinkChatIfSame(db, delivery.doc.user, chatId);
      }
    }
  });
  return result;
}
