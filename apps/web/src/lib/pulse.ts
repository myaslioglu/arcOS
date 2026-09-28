/**
 * The wallpaper's live chart: each of the last 1,024 Arc blocks' gas-used ratio (about 9 minutes at 0.51 s a block),
 * from eth_feeHistory. Kept free of "server-only" so its rules can be tested: pulse-server.ts wires it to the server's
 * RPC client, and pulse-client.ts reads the route's answer in the browser.
 */
export const PULSE_BLOCKS = 1024;
/** How long one answer is kept, per server process. */
export const PULSE_TTL_MS = 60_000;
/** How long a failed call is kept, so an outage isn't asked about again on every request. */
export const PULSE_FAILURE_TTL_MS = 10_000;

export type Pulse = { oldestBlock: number; ratios: number[] };

/** What viem's getFeeHistory answers, as far as the pulse needs it. */
export type FeeHistoryAnswer = { oldestBlock: bigint; gasUsedRatio: readonly number[] };

/** The route's answer: the oldest block as a number, and each ratio kept within 0..1 and rounded to 4 decimals. */
export function toPulse(history: FeeHistoryAnswer): Pulse {
  return {
    oldestBlock: Number(history.oldestBlock),
    ratios: history.gasUsedRatio.map((r) =>
      Number.isFinite(r) ? Math.round(Math.min(Math.max(r, 0), 1) * 10_000) / 10_000 : 0,
    ),
  };
}

/** A /api/pulse answer read from the wire, checked field by field; anything else throws. */
export function parsePulse(json: unknown): Pulse {
  const o = typeof json === "object" && json !== null ? (json as { oldestBlock?: unknown; ratios?: unknown }) : {};
  const { oldestBlock, ratios } = o;
  if (typeof oldestBlock !== "number" || !Number.isSafeInteger(oldestBlock)) throw new Error("Not a pulse answer.");
  if (!Array.isArray(ratios) || !ratios.every((r) => typeof r === "number" && Number.isFinite(r))) {
    throw new Error("Not a pulse answer.");
  }
  return { oldestBlock, ratios: ratios as number[] };
}

/**
 * One answer per server process. Requests that arrive while a call runs share it; an answer is kept for 60 s after it
 * arrives, and a failure for 10 s, so an RPC outage costs one call every 10 s rather than one per request.
 */
export function pulseCache(load: () => Promise<Pulse>, now: () => number = Date.now) {
  let entry: { value: Promise<Pulse>; until: number } | null = null;
  return {
    get(): Promise<Pulse> {
      if (entry && now() < entry.until) return entry.value;
      const current = { value: load(), until: Number.POSITIVE_INFINITY };
      entry = current;
      current.value.then(
        () => {
          current.until = now() + PULSE_TTL_MS;
        },
        () => {
          current.until = now() + PULSE_FAILURE_TTL_MS;
        },
      );
      return current.value;
    },
  };
}
