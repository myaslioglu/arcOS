import { isAddress } from "viem";
import type { NetworkId } from "@arcos/chain";
import type { PoolDoc, PoolQuote, PoolVersion, V4PoolKey } from "@arcos/data";
import type { ExtraPool } from "@arcos/inspector";

// The pools the indexer recorded for a token (Firestore pools/, mainnet only): what GET /api/pools/[token] answers, and
// what the Inspector reads besides the pools its own discovery finds (`extraPools`), on the server and in the browser.
// This module is pure: the Firestore read lives in indexed-pools-server.ts.

/** One indexed pool, as the route answers it. */
export type IndexedPool = {
  id: string;
  version: PoolVersion;
  quote: PoolQuote;
  fee: number | null;
  createdBlock: number;
  /** Uniswap v4 only: the pool key, hook included. */
  key: V4PoolKey | null;
  /** The last sampled depth in USDC's 6-decimal units, or null when none has been sampled. */
  depthUsdc: string | null;
};

export type PoolsAnswer = { pools: IndexedPool[] };

/** The route's answer from the stored docs, newest pool first. */
export function poolsAnswer(docs: readonly PoolDoc[]): PoolsAnswer {
  return {
    pools: [...docs]
      .sort((a, b) => b.createdBlock - a.createdBlock)
      .map((doc) => ({
        id: doc.poolId,
        version: doc.version,
        quote: doc.quote,
        fee: doc.fee,
        createdBlock: doc.createdBlock,
        key: doc.key,
        depthUsdc: doc.depthUsdc,
      })),
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isUint = (v: unknown, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;
const isSpacing = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 32_767;
const isAddr = (v: unknown): v is `0x${string}` => typeof v === "string" && isAddress(v, { strict: false });

/**
 * The v4 pool keys in an answer, as the Inspector's `extraPools`. Anything that isn't a well-formed key is left out:
 * the answer crossed the network, and the Inspector reads at most 50 of these anyway.
 */
export function extraPoolsFrom(answer: unknown): ExtraPool[] {
  if (!isRecord(answer) || !Array.isArray(answer.pools)) return [];
  const out: ExtraPool[] = [];
  for (const pool of answer.pools) {
    if (!isRecord(pool) || pool.version !== "v4" || !isRecord(pool.key)) continue;
    const { currency0, currency1, fee, tickSpacing, hooks } = pool.key;
    if (!isAddr(currency0) || !isAddr(currency1) || !isAddr(hooks) || !isUint(fee, 0xffffff) || !isSpacing(tickSpacing)) continue;
    out.push({ version: "v4", key: { currency0, currency1, fee, tickSpacing, hooks } });
  }
  return out;
}

/** The index can't be read right now: it failed or timed out a moment ago, or this server has no Firestore. */
export class IndexUnavailable extends Error {
  constructor(message = "The pool index can't be read right now.") {
    super(message);
    this.name = "IndexUnavailable";
  }
}

/**
 * Whether this server reads the index. Firestore holds mainnet data only (D6), so never on testnet. And only where the
 * runtime gives the site its own account: App Hosting (Cloud Run sets K_SERVICE), or the Firestore emulator. A dev
 * server or a CI build reads nothing, so nobody's own credentials ever reach the live database from a laptop.
 */
export function indexEnabled(network: NetworkId, env: Readonly<Record<string, string | undefined>>): boolean {
  return network === "mainnet" && Boolean(env.K_SERVICE || env.FIRESTORE_EMULATOR_HOST);
}

/**
 * A token's indexed pools through `load`, with three guards: a read that takes longer than `deadlineMs` counts as a
 * failure; after a failure no read is tried for `cooldownMs`, so an outage costs one wait a minute, not one per page; and
 * an answer is kept `ttlMs` per token.
 */
export function indexedPoolsSource({
  load,
  now = Date.now,
  deadlineMs = 1_500,
  cooldownMs = 60_000,
  ttlMs = 60_000,
  maxKeys = 1_000,
}: {
  load: (token: string) => Promise<PoolDoc[]>;
  now?: () => number;
  deadlineMs?: number;
  cooldownMs?: number;
  ttlMs?: number;
  maxKeys?: number;
}) {
  let downUntil = 0;
  const cache = new Map<string, { at: number; value: Promise<PoolDoc[]> }>();
  return {
    pools(token: string): Promise<PoolDoc[]> {
      const key = token.toLowerCase();
      const hit = cache.get(key);
      if (hit && now() - hit.at <= ttlMs) return hit.value;
      if (now() < downUntil) return Promise.reject(new IndexUnavailable());
      const value = new Promise<PoolDoc[]>((resolve, reject) => {
        const timer = setTimeout(() => reject(new IndexUnavailable("The pool index took too long.")), deadlineMs);
        load(key).then(
          (docs) => {
            clearTimeout(timer);
            resolve(docs);
          },
          () => {
            clearTimeout(timer);
            reject(new IndexUnavailable());
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

/**
 * The browser Inspector's extra pools: GET /api/pools/[token], at most 3 s. Anything but a good answer is "no indexed
 * pools": a 404 (testnet has no index), a 503, a timeout. Discovery still runs without them.
 */
export async function fetchExtraPools(token: string, fetchFn: typeof fetch = fetch): Promise<ExtraPool[]> {
  try {
    const res = await fetchFn(`/api/pools/${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(3_000) });
    return res.ok ? extraPoolsFrom(await res.json()) : [];
  } catch {
    return [];
  }
}
