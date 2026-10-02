import { INSPECT_PRIORITY, INSPECT_QUEUE_MAX_AGE_MS, type TimestampLike, type TokenDoc } from "@arcos/data";

// The inspection queue (design 1.3, step 8), as pure rules over token docs. The store reads the queue in this order
// (the composite index network, inspect.state, inspect.priority desc, firstSeen desc) and writes what these return.

type Inspect = TokenDoc["inspect"];

/** A failed inspection is tried again on later runs; the third failure skips the token. */
export const MAX_ATTEMPTS = 3;

/** The queue entry of a token the index has just found. With the console's `inspect` switch off it is skipped. */
export function newInspect(enabled: boolean, pooled: boolean, now: TimestampLike): Inspect {
  const priority = pooled ? INSPECT_PRIORITY.pooled : INSPECT_PRIORITY.bare;
  return enabled ? { state: "queued", priority, attempts: 0, queuedAt: now } : { state: "skipped", priority, attempts: 0, queuedAt: null };
}

/**
 * A new pool appeared for a token the index already knows: its report may change, so it is queued again, a token last
 * found liquid first. A token still queued keeps its place in time and moves up to the pooled priority if it was below.
 * Null when nothing changes.
 */
export function requeue(current: TokenDoc, enabled: boolean, now: TimestampLike): Inspect | null {
  if (!enabled) return null;
  const { inspect } = current;
  if (inspect.state === "queued") {
    return inspect.priority >= INSPECT_PRIORITY.pooled ? null : { ...inspect, priority: INSPECT_PRIORITY.pooled };
  }
  const priority = current.radar.liquid ? INSPECT_PRIORITY.liquid : INSPECT_PRIORITY.pooled;
  return { state: "queued", priority, attempts: 0, queuedAt: now };
}

/** The queue's order: the highest priority first, then the newest token. */
export function queueOrder(a: TokenDoc, b: TokenDoc): number {
  return b.inspect.priority - a.inspect.priority || b.firstSeen.toMillis() - a.firstSeen.toMillis();
}

/**
 * From the head of the queue, in queue order: the first `perTick` tokens to inspect now, and every one that has waited
 * 24 hours or more, which is skipped instead (design 1.3: it is inspected when someone opens it).
 */
export function pickQueue(head: readonly TokenDoc[], now: TimestampLike, perTick: number): { inspect: TokenDoc[]; expire: TokenDoc[] } {
  const inspect: TokenDoc[] = [];
  const expire: TokenDoc[] = [];
  for (const token of head) {
    const queuedAt = token.inspect.queuedAt;
    if (queuedAt === null || now.toMillis() - queuedAt.toMillis() >= INSPECT_QUEUE_MAX_AGE_MS) expire.push(token);
    else if (inspect.length < perTick) inspect.push(token);
  }
  return { inspect, expire };
}

/** The queue entry after an inspection that failed (a timeout, an RPC outage). */
export function afterFailure(inspect: Inspect): Inspect {
  const attempts = inspect.attempts + 1;
  return attempts >= MAX_ATTEMPTS ? { ...inspect, state: "skipped", attempts, queuedAt: null } : { ...inspect, attempts };
}

/** The queue entry of a token whose queue time ran out. */
export const expired = (inspect: Inspect): Inspect => ({ ...inspect, state: "skipped", queuedAt: null });
