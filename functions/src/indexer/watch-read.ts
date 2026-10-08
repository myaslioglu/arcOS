import { parseAbi } from "viem";
import { DEX, EURC, USDC, type Address, type NetworkId } from "@arcos/chain";
import { sanitizeSymbol, type PoolQuote, type PoolVersion, type V4PoolKey, type WatchObservation } from "@arcos/data";
import {
  CallReverted,
  IMPL_SLOT,
  InspectionTimeout,
  NATIVE,
  ZEPPELINOS_IMPL_SLOT,
  addressFromSlot,
  erc20Abi,
  multicall,
  quoteInRange,
  slotReadable,
  stateViewAbi,
  withDeadline,
  type BatchCall,
  type BatchResult,
  type ChainReader,
} from "@arcos/inspector";

// One check of a watched token (design 3.1): what the rules in @arcos/data's watch.ts diff against the stored state.
// Three requests, every one pinned to the run's finalized block: one aggregate3 through Multicall3 for the owner, the
// supply, the pause flag, the label and the deepest pool's depth, and two eth_getStorageAt for the implementation
// slots. A request that fails leaves its fields unread (`ok: false`), which keeps the stored values and never alerts.

/** The owner views the checks read, and the pause flag of a Pausable token. */
export const ownableAbi = parseAbi([
  "function owner() view returns (address)",
  "function getOwner() view returns (address)",
  "function paused() view returns (bool)",
]);
/** A Uniswap v2 pair's reserves: reserve0 is token0's, the numerically lower address of the two. */
export const v2PairAbi = parseAbi(["function getReserves() view returns (uint112, uint112, uint32)"]);

/** The deepest pool as the index knows it (tokens.bestPool joined with its pools doc). */
export type WatchPoolInput = { id: string; version: PoolVersion; quote: PoolQuote; key: V4PoolKey | null };

export type WatchReadInput = {
  network: NetworkId;
  token: Address;
  /** Null when the token has no known deepest pool, or its pools doc is missing. */
  pool: WatchPoolInput | null;
  /** The label the index holds, shown when the chain's own symbol or decimals can't be read. */
  label: { symbol: string | null; decimals: number | null };
};

/** Why a request failed: a timeout, a transport failure, or the aggregate itself reverting. The first of the three requests' failures, in their order. */
export type ReadFailure = "timeout" | "transport" | "reverted";

export type WatchRead = { observation: WatchObservation; failure: ReadFailure | null };

/** How long each of the three requests may take. */
export const READ_TIMEOUT_MS = 5_000;

const lower = (a: string): string => a.toLowerCase();

/** The quote currency of a pool and the decimals its amounts carry; null for a quote this reader can't price. */
function quoteOf(quote: PoolQuote, network: NetworkId, version: PoolVersion): { address: Address; decimals: number } | null {
  if (quote === "USDC") return { address: USDC, decimals: 6 };
  if (quote === "EURC") return { address: EURC[network], decimals: 6 };
  // Native USDC is a v4 currency (address 0, 18 decimals); no other venue holds it.
  return version === "v4" ? { address: NATIVE, decimals: 18 } : null;
}

const toSixDecimals = (raw: bigint, decimals: number): bigint =>
  decimals >= 6 ? raw / 10n ** BigInt(decimals - 6) : raw * 10n ** BigInt(6 - decimals);

const failureOf = (e: unknown): ReadFailure => (e instanceof InspectionTimeout ? "timeout" : e instanceof CallReverted ? "reverted" : "transport");

type PoolAsk = { calls: BatchCall[]; depth(results: BatchResult[]): bigint | null };

/** The pool's calls in the aggregate, and how to read its depth (in 6-decimal quote units) from their answers. Null for an unusable pool. */
function poolAsk(pool: WatchPoolInput, token: Address, network: NetworkId): PoolAsk | null {
  const quote = quoteOf(pool.quote, network, pool.version);
  if (quote === null) return null;
  const target = pool.id as Address;
  if (pool.version === "v2") {
    const quoteIsToken0 = lower(quote.address) < lower(token);
    return {
      calls: [{ target, abi: v2PairAbi, functionName: "getReserves" }],
      depth: ([r]) => {
        if (!r?.ok) return null;
        const reserves = r.value as readonly [bigint, bigint, number];
        return toSixDecimals(quoteIsToken0 ? reserves[0] : reserves[1], quote.decimals);
      },
    };
  }
  if (pool.version === "v3" || pool.version === "aero") {
    return {
      calls: [{ target: quote.address, abi: erc20Abi, functionName: "balanceOf", args: [target] }],
      depth: ([r]) => (r?.ok ? toSixDecimals(r.value as bigint, quote.decimals) : null),
    };
  }
  const { key } = pool;
  const stateView = DEX[network]?.v4?.stateView;
  if (key === null || stateView === undefined) return null;
  const quoteIsCurrency0 = lower(key.currency0) === lower(quote.address);
  return {
    calls: [
      { target: stateView, abi: stateViewAbi, functionName: "getSlot0", args: [pool.id] },
      { target: stateView, abi: stateViewAbi, functionName: "getLiquidity", args: [pool.id] },
    ],
    depth: ([slot0, liquidity]) => {
      if (!slot0?.ok || !liquidity?.ok) return null;
      const [sqrtPriceX96, tick] = slot0.value as readonly [bigint, number, number, number];
      if (sqrtPriceX96 <= 0n) return null;
      const held = quoteInRange({ sqrtPriceX96, tick, tickSpacing: key.tickSpacing, liquidity: liquidity.value as bigint, quoteIsCurrency0 });
      return toSixDecimals(held, quote.decimals);
    },
  };
}

/** The slot's address, or the three outcomes a slot read can have besides one: unset, unread (rejected or malformed). */
type Slot = { ok: true; value: Address | null } | { ok: false };

const slotOf = (word: PromiseSettledResult<`0x${string}` | null>): Slot => {
  if (word.status === "rejected" || !slotReadable(word.value)) return { ok: false };
  return { ok: true, value: addressFromSlot(word.value) };
};

/**
 * Reads a token at `block`: three requests, each within READ_TIMEOUT_MS. The aggregate's calls are owner(), getOwner(),
 * totalSupply(), paused(), symbol(), decimals() and the pool's (a v2 pair's reserves, a v3 or Aerodrome pool's quote
 * balance, or a v4 pool's slot0 and liquidity, priced with quoteInRange); every call may fail on its own. The two slot
 * reads are EIP-1967's implementation slot and ZeppelinOS's, in that order of precedence.
 *
 * An aggregate that rejects leaves owner, totalSupply, paused and pool unread; a call that failed inside one that
 * answered is absent (null), except a pool call, which leaves the pool unread (a depth of 0 would read as a drop). A
 * slot that rejects or answers a malformed word leaves the implementation unread. The label falls back to the index's
 * when the chain's symbol can't be decoded (a bytes32 symbol) or decimals can't.
 */
export async function readWatchToken(reader: ChainReader, input: WatchReadInput, block: number, timeoutMs = READ_TIMEOUT_MS): Promise<WatchRead> {
  const { token, network } = input;
  const blockNumber = BigInt(block);
  const pool = input.pool === null ? null : poolAsk(input.pool, token, network);
  const base: BatchCall[] = [
    { target: token, abi: ownableAbi, functionName: "owner" },
    { target: token, abi: ownableAbi, functionName: "getOwner" },
    { target: token, abi: erc20Abi, functionName: "totalSupply" },
    { target: token, abi: ownableAbi, functionName: "paused" },
    { target: token, abi: erc20Abi, functionName: "symbol" },
    { target: token, abi: erc20Abi, functionName: "decimals" },
  ];
  const [aggregate, implSlot, zosSlot] = await Promise.allSettled([
    withDeadline(multicall(reader, [...base, ...(pool?.calls ?? [])], { blockNumber }), undefined, timeoutMs),
    withDeadline(reader.getStorageAt(token, IMPL_SLOT, blockNumber), undefined, timeoutMs),
    withDeadline(reader.getStorageAt(token, ZEPPELINOS_IMPL_SLOT, blockNumber), undefined, timeoutMs),
  ]);

  let failure: ReadFailure | null = null;
  const unread = { ok: false } as const;
  let observation: WatchObservation;
  if (aggregate.status === "rejected") {
    failure = failureOf(aggregate.reason);
    observation = {
      block,
      owner: unread,
      totalSupply: unread,
      paused: unread,
      implementation: unread,
      pool: unread,
      label: { symbol: sanitizeSymbol(input.label.symbol), decimals: input.label.decimals, quote: null },
    };
  } else {
    const [owner, getOwner, totalSupply, paused, symbol, decimals, ...poolResults] = aggregate.value;
    const ownerValue = owner!.ok ? owner!.value : getOwner!.ok ? getOwner!.value : null;
    const chainSymbol = symbol!.ok && typeof symbol!.value === "string" ? sanitizeSymbol(symbol!.value) : null;
    const chainDecimals = decimals!.ok && typeof decimals!.value === "number" ? decimals!.value : null;
    const depth = pool === null ? null : pool.depth(poolResults);
    observation = {
      block,
      owner: { ok: true, value: typeof ownerValue === "string" ? (lower(ownerValue) as Address) : null },
      totalSupply: { ok: true, value: totalSupply!.ok && typeof totalSupply!.value === "bigint" ? totalSupply!.value : null },
      paused: { ok: true, value: paused!.ok && typeof paused!.value === "boolean" ? paused!.value : null },
      implementation: unread,
      pool: pool === null ? { ok: true, value: null } : depth === null ? unread : { ok: true, value: { id: lower(input.pool!.id), depth } },
      label: {
        symbol: chainSymbol ?? sanitizeSymbol(input.label.symbol),
        decimals: chainDecimals ?? input.label.decimals,
        quote: input.pool === null ? null : input.pool.quote === "EURC" ? "EURC" : "USDC",
      },
    };
  }

  const impl = slotOf(implSlot);
  const zos = slotOf(zosSlot);
  if (impl.ok && zos.ok) observation.implementation = { ok: true, value: impl.value ?? zos.value };
  // A malformed word leaves the implementation unread but is no request failure: only a rejection names one.
  for (const word of [implSlot, zosSlot]) if (word.status === "rejected") failure ??= failureOf(word.reason);
  return { observation, failure };
}
