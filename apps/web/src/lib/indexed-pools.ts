import { isAddress } from "viem";
import type { PoolDoc, PoolQuote, PoolVersion, V4PoolKey } from "@arcos/data";
import type { ExtraPool } from "@arcos/inspector";
import { indexSource, type IndexSourceOptions } from "./index-source";

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

export { IndexUnavailable, causeCode, indexEnabled } from "./index-source";

/**
 * A token's indexed pools through `load`, with the guards of `indexSource` (index-source.ts): a 1.5 s deadline, a
 * 60 s cooldown after a failure, and an answer kept 60 s per token, whatever the case of its address.
 */
export function indexedPoolsSource(opts: Omit<IndexSourceOptions<PoolDoc[]>, "timeoutMessage" | "unavailableMessage">) {
  const s = indexSource<PoolDoc[]>({
    ...opts,
    timeoutMessage: "The pool index took too long.",
    unavailableMessage: "The pool index can't be read right now.",
  });
  return { pools: (token: string) => s.get(token.toLowerCase()) };
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
