import { isAddress } from "viem";
import type { PoolDoc, PoolQuote, PoolVersion, V4PoolKey } from "@arcos/data";
import { MAX_POSITIONS, MAX_POSITIONS_PER_POOL, isPositionKey, type ExtraPool, type V4PositionIndex } from "@arcos/inspector";
import { indexSource, type IndexSourceOptions } from "./index-source";

// The pools the indexer recorded for a token (Firestore pools/, mainnet only) and the liquidity positions it recorded
// for the token's Uniswap v4 pools (positions/): what GET /api/pools/[token] answers, and what the Inspector reads besides
// the pools its own discovery finds (`extraPools`, `v4Positions`), on the server and in the browser.
// This module is pure: the Firestore reads live in indexed-pools-server.ts.

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

/**
 * `truncated`: the index holds more pools for the token than `pools` lists (it reads 50); present only when true.
 * `positions`: the position index for the token's v4 pools (the Inspector's `V4PositionIndex`): its cursor, and for each
 * pool id the position keys it holds, at most 500 a pool and 2,000 in all, else `truncated`. Absent before the position
 * index's first run, while it is switched off, or when it couldn't be read.
 */
export type PoolsAnswer = { pools: IndexedPool[]; truncated?: true; positions?: V4PositionIndex };

/** A token's pools as the index lists them, and whether it holds more than it listed. */
export type IndexedPools = { pools: PoolDoc[]; truncated: boolean };

/** What the index holds for a token: its pools, and its v4 pools' positions (null when there are none to give). */
export type IndexedToken = IndexedPools & { positions: V4PositionIndex | null };

/** The route's answer from the stored docs, newest pool first, with the positions when there are any to give. */
export function poolsAnswer(docs: readonly PoolDoc[], positions: V4PositionIndex | null = null, truncated = false): PoolsAnswer {
  return {
    ...(truncated ? { truncated: true as const } : {}),
    ...(positions ? { positions } : {}),
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

const POOL_ID = /^0x[0-9a-f]{64}$/;

/**
 * The position index in an answer, as the Inspector's `v4Positions`, or undefined when the answer has none. The answer
 * crossed the network, so only what is well formed is kept: a cursor that is a block number, pool ids of 32 bytes, and
 * for each pool a list of position keys within the Inspector's caps. A pool whose entry is anything else is left out,
 * which the lp-lock check reads as "not in the index" and never as "no positions".
 */
export function positionsFrom(answer: unknown): V4PositionIndex | undefined {
  if (!isRecord(answer) || !isRecord(answer.positions)) return undefined;
  const { cursor, pools } = answer.positions;
  if (typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor < 0 || !isRecord(pools)) return undefined;
  const out: V4PositionIndex = { cursor, pools: {} };
  let total = 0;
  for (const [id, entry] of Object.entries(pools)) {
    if (!POOL_ID.test(id) || !isRecord(entry) || typeof entry.truncated !== "boolean" || !Array.isArray(entry.positions)) continue;
    if (entry.positions.length > MAX_POSITIONS_PER_POOL || !entry.positions.every(isPositionKey)) continue;
    total += entry.positions.length;
    if (total > MAX_POSITIONS) break;
    out.pools[id] = {
      positions: entry.positions.map(({ owner, tickLower, tickUpper, salt }) => ({ owner, tickLower, tickUpper, salt })),
      truncated: entry.truncated,
    };
  }
  return out;
}

export { IndexUnavailable, causeCode, indexEnabled } from "./index-source";

/**
 * A token's indexed pools through `load`, with the guards of `indexSource` (index-source.ts): a 1.5 s deadline, a 60 s
 * cooldown after a failure, and an answer kept 60 s per token, whatever the case of its address.
 */
export function indexedPoolsSource(opts: Omit<IndexSourceOptions<IndexedPools>, "timeoutMessage" | "unavailableMessage">) {
  const s = indexSource<IndexedPools>({
    ...opts,
    timeoutMessage: "The pool index took too long.",
    unavailableMessage: "The pool index can't be read right now.",
  });
  return { pools: (token: string) => s.get(token.toLowerCase()) };
}

/**
 * The positions of a token's v4 pools through `load`, apart from the pools: a deadline of its own (1.5 s) and an answer
 * kept 60 s per token, but NO cooldown. A token with many positions can be slow or fail where every other token is
 * fine, and one token's slow positions must never stop the next token's pools from being read. A failure here is that
 * token's alone: the caller answers the pools without positions.
 */
export function indexedPositionsSource(opts: Omit<IndexSourceOptions<V4PositionIndex | null>, "timeoutMessage" | "unavailableMessage" | "cooldownMs">) {
  const s = indexSource<V4PositionIndex | null>({
    ...opts,
    cooldownMs: 0,
    timeoutMessage: "The position index took too long.",
    unavailableMessage: "The position index can't be read right now.",
  });
  return { positions: (token: string) => s.get(token.toLowerCase()) };
}

/**
 * What the index adds to an inspection: the token's v4 pools, whether the index holds more of them than it listed, and
 * their positions when the index has them.
 */
export type IndexedExtras = { extraPools: ExtraPool[]; extraPoolsTruncated?: boolean; v4Positions?: V4PositionIndex };

/** An answer of the route as an inspection's extras. */
export function extrasFrom(answer: unknown): IndexedExtras {
  const v4Positions = positionsFrom(answer);
  const truncated = isRecord(answer) && answer.truncated === true;
  return { extraPools: extraPoolsFrom(answer), ...(truncated ? { extraPoolsTruncated: true } : {}), ...(v4Positions ? { v4Positions } : {}) };
}

/**
 * The browser Inspector's extras: GET /api/pools/[token], at most 3 s. Anything but a good answer is "nothing indexed": a
 * 404 (testnet has no index), a 503, a timeout. Discovery still runs without the pools, and lp-lock answers without the
 * positions as it does where there is no index.
 */
export async function fetchIndexedExtras(token: string, fetchFn: typeof fetch = fetch): Promise<IndexedExtras> {
  try {
    const res = await fetchFn(`/api/pools/${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(3_000) });
    return res.ok ? extrasFrom(await res.json()) : { extraPools: [] };
  } catch {
    return { extraPools: [] };
  }
}

/** The extra pools alone (see `fetchIndexedExtras`). */
export const fetchExtraPools = async (token: string, fetchFn: typeof fetch = fetch): Promise<ExtraPool[]> => (await fetchIndexedExtras(token, fetchFn)).extraPools;
