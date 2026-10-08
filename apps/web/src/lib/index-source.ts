import type { NetworkId } from "@arcos/chain";

// What every read of the token index shares (Firestore, mainnet only): when this server reads it at all, how a failed
// read is reported, and a cached source with a deadline and a cooldown. Pure: the Firestore reads live in the server
// modules (indexed-pools-server.ts, radar-server.ts).

/**
 * The index can't be read right now: it failed or timed out a moment ago, or this server has no Firestore. `cause` is
 * the read's own error when one failed (a Firestore error carries a gRPC `code`: 7 is PERMISSION_DENIED, 16
 * UNAUTHENTICATED, 5 NOT_FOUND for the database, 4 DEADLINE_EXCEEDED, 14 UNAVAILABLE); the route logs that code only.
 */
export class IndexUnavailable extends Error {
  constructor(message = "The index can't be read right now.", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "IndexUnavailable";
  }
}

/** The `code` of an error's cause when it is a number or a short word (a gRPC status, a JSON-RPC code, `ECONNRESET`). */
export function causeCode(e: unknown): number | string | undefined {
  const cause = e instanceof Error ? (e.cause as { code?: unknown } | undefined) : undefined;
  const code = typeof cause === "object" && cause !== null ? cause.code : undefined;
  if (typeof code === "number" && Number.isFinite(code)) return code;
  if (typeof code === "string" && /^[\w.-]{1,64}$/.test(code)) return code;
  return undefined;
}

/**
 * Whether this server reads the index. Firestore holds mainnet data only (D6), so never on testnet. And only where the
 * runtime gives the site its own account: App Hosting (Cloud Run sets K_SERVICE), or the Firestore emulator. A dev
 * server or a CI build reads nothing, so nobody's own credentials ever reach the live database from a laptop.
 */
export function indexEnabled(network: NetworkId, env: Readonly<Record<string, string | undefined>>): boolean {
  return network === "mainnet" && Boolean(env.K_SERVICE || env.FIRESTORE_EMULATOR_HOST);
}

export type IndexSourceOptions<T> = {
  load: (key: string) => Promise<T>;
  now?: () => number;
  deadlineMs?: number;
  cooldownMs?: number;
  ttlMs?: number;
  maxKeys?: number;
  /** What the rejection says when a read outlives the deadline. */
  timeoutMessage?: string;
  /** What the rejection says when a read failed, or none is tried during the cooldown. */
  unavailableMessage?: string;
};

/**
 * One answer per key through `load`, with three guards: a read that takes longer than `deadlineMs` counts as a
 * failure; after a failure no read is tried for `cooldownMs`, so an outage costs one wait a minute, not one per page; and
 * an answer is kept `ttlMs` per key, at most `maxKeys` of them (the oldest goes first). The key is passed to `load` as
 * given: a caller that wants it normalised (an address lowercased) does that before `get`. A failure is never kept as
 * an answer.
 */
export function indexSource<T>({
  load,
  now = Date.now,
  deadlineMs = 1_500,
  cooldownMs = 60_000,
  ttlMs = 60_000,
  maxKeys = 1_000,
  timeoutMessage = "The index took too long.",
  unavailableMessage = "The index can't be read right now.",
}: IndexSourceOptions<T>) {
  let downUntil = 0;
  const cache = new Map<string, { at: number; value: Promise<T> }>();
  return {
    get(key: string): Promise<T> {
      const hit = cache.get(key);
      if (hit && now() - hit.at <= ttlMs) return hit.value;
      if (now() < downUntil) return Promise.reject(new IndexUnavailable(unavailableMessage));
      const value = new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new IndexUnavailable(timeoutMessage)), deadlineMs);
        load(key).then(
          (answer) => {
            clearTimeout(timer);
            resolve(answer);
          },
          (e: unknown) => {
            clearTimeout(timer);
            reject(new IndexUnavailable(unavailableMessage, { cause: e }));
          },
        );
      });
      const entry = { at: now(), value };
      cache.delete(key);
      cache.set(key, entry);
      if (cache.size > maxKeys) cache.delete(cache.keys().next().value as string);
      value.catch(() => {
        downUntil = now() + cooldownMs;
        if (cache.get(key) === entry) cache.delete(key);
      });
      return value;
    },
  };
}
