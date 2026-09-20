export type RateDecision = { ok: true } | { ok: false; retryAfterSec: number };

type Window = { start: number; count: number };

/** Fixed-window counter per key. Per server instance — a first line of defence, not a guarantee. */
export function rateLimiter(limit: number, windowMs: number, maxKeys = 5000, now: () => number = Date.now) {
  const windows = new Map<string, Window>();
  return {
    take(key: string): RateDecision {
      const t = now();
      const current = windows.get(key);
      if (!current || t - current.start >= windowMs) {
        windows.delete(key);
        windows.set(key, { start: t, count: 1 });
        if (windows.size > maxKeys) windows.delete(windows.keys().next().value as string);
        return { ok: true };
      }
      if (current.count < limit) {
        current.count += 1;
        return { ok: true };
      }
      const retryAfterSec = Math.max(1, Math.ceil((current.start + windowMs - t) / 1000));
      return { ok: false, retryAfterSec };
    },
  };
}

/**
 * Bounds concurrent work per process. `run` throws the caller-supplied error once `max` calls
 * are already in flight; the slot frees in `finally` whether the call succeeds or fails.
 */
export function inFlightGate(max: number, makeError: () => Error) {
  let count = 0;
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (count >= max) throw makeError();
      count += 1;
      try {
        return await fn();
      } finally {
        count -= 1;
      }
    },
  };
}
