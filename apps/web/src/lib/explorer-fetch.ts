/** How long one explorer request may take before it counts as an outage. */
const REQUEST_TIMEOUT_MS = 8_000;

/**
 * The `fetch` one inspection gives its explorer source. Each request waits for a turn from `turn` (the per-process pacer
 * in inspect-server.ts), then goes out with a signal that ends it after 8 s, when the caller's own signal (if any)
 * aborts, or when `inspection` does — the inspection's deadline aborts that one. `inspection` is also checked before
 * waiting for a turn and again before sending, so nothing still queued is sent once the inspection has given up.
 *
 * Every way this rejects reaches `blockscoutSource` as a failed fetch, which it reports as `ExplorerUnavailable`: the
 * explorer checks read unknown and the report is degraded, but the inspection itself carries on.
 */
export function explorerFetch(turn: () => Promise<void>, inspection: AbortSignal, fetchFn: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    inspection.throwIfAborted();
    await turn();
    inspection.throwIfAborted();
    const signals = [inspection, AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
    if (init?.signal) signals.push(init.signal);
    return fetchFn(input, { ...init, signal: AbortSignal.any(signals) });
  };
}
