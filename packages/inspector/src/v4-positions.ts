import { decodeAbiParameters, isAddress, parseAbi, toEventSelector } from "viem";
import { BURN_ADDRESSES, type Address, type UniswapV4Config } from "@arcos/chain";
import type { Hex } from "./bytecode";
import { multicall, type BatchCall, type BatchResult } from "./multicall";
import { CallReverted, type ChainReader, type PoolKey, type V4PositionIndex, type V4PositionKey } from "./types";
import { sqrtRatioAtTick, toSixDecimals } from "./v4";

// Who holds the liquidity of a Uniswap v4 pool. A v4 position has no token of its own: it is an entry in the PoolManager
// keyed by (pool id, owner, tickLower, tickUpper, salt), and only the `ModifyLiquidity` logs say which entries exist. The
// index (`InspectInput.v4Positions`) lists them; everything else is read live here, at one block:
// 1. the blocks after the index's cursor (at most `TAIL_MAX_BLOCKS` of them): `Initialize` with the token as currency0
//    and as currency1, which names the token's pools created since the cursor (one the caller asked about has every
//    position in the tail, so it needs no entry in the index; one it didn't ask about is reported as `unlisted`), then
//    the asked pools' `ModifyLiquidity`;
// 2. each position's liquidity (`StateView.getPositionInfo`), the pool's price and tick (`getSlot0`) and its active
//    liquidity (`getLiquidity`), in multicalls pinned to one block, `HEAD_MARGIN` behind the latest;
// 3. for a PositionManager position, whose salt is its NFT's token id, the NFT's owner (`ownerOf`), at the same block.
// What the lists can't be trusted for is checked against the chain: the liquidity of the positions whose range holds the
// current tick must add up to the pool's active liquidity exactly, or the pool is reported as not readable (`mismatch`).
//
// What a position is measured by is the quote currency only (see `positionQuote`): what it holds of it now, and what
// buyers would pay into it before the token's price doubles. Its token side is never given a price. Tokens cost their
// deployer nothing and a pool's price is whatever its initializer chose, so a token amount times a pool's price is a
// number anyone can make as large as they like.

const modifyLiquidityEvent = parseAbi([
  "event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)",
]);
/** topic0 of the PoolManager's `ModifyLiquidity`: every change to a position's liquidity emits one. */
export const MODIFY_LIQUIDITY_TOPIC: Hex = toEventSelector(modifyLiquidityEvent[0]);

const initializeEvent = parseAbi([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
]);
/** topic0 of the PoolManager's `Initialize`: one per pool, with its two currencies as topics 2 and 3. */
export const INITIALIZE_TOPIC: Hex = toEventSelector(initializeEvent[0]);

const positionInfoAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
  "function getPositionInfo(bytes32 poolId, address owner, int24 tickLower, int24 tickUpper, bytes32 salt) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128)",
]);
const erc721Abi = parseAbi(["function ownerOf(uint256 tokenId) view returns (address)"]);

/** The most positions of one pool the check reads; a pool with more is `truncated`, which is never a pass. */
export const MAX_POSITIONS_PER_POOL = 500;
/** The most positions one inspection reads over all of a token's pools. */
export const MAX_POSITIONS = 2_000;
/** How far behind the head the index's cursor may be: the blocks after it are read in one eth_getLogs, which Arc caps at 10,000. */
export const TAIL_MAX_BLOCKS = 10_000;
/** How many holders' code is read to tell a wallet from a contract, the largest first; the rest stay unclassified. */
export const MAX_HOLDER_CODE_READS = 40;
/** How many blocks behind the node's latest everything is read at (about a second on Arc). */
export const HEAD_MARGIN = 2n;
/** Calls per aggregate3. A position read costs a few thousand gas, so a batch stays far below an eth_call's allowance. */
const BATCH = 200;
const BATCH_CONCURRENCY = 4;
const CODE_CONCURRENCY = 6;

const MIN_TICK = -887_272;
const MAX_TICK = 887_272;
const Q96 = 1n << 96n;
const lower = (a: string) => a.toLowerCase();

/** One `ModifyLiquidity` log as a position: the pool it is in and its key. Null for anything that isn't one. */
export function positionFromLog(log: { topics: readonly Hex[]; data: Hex }): { poolId: Hex; key: V4PositionKey } | null {
  if (log.topics.length !== 3 || lower(log.topics[0]!) !== MODIFY_LIQUIDITY_TOPIC) return null;
  try {
    const [tickLower, tickUpper, , salt] = decodeAbiParameters([{ type: "int24" }, { type: "int24" }, { type: "int256" }, { type: "bytes32" }], log.data);
    const [owner] = decodeAbiParameters([{ type: "address" }], log.topics[2]!);
    return { poolId: lower(log.topics[1]!) as Hex, key: { owner: lower(owner) as Address, tickLower, tickUpper, salt: lower(salt) as Hex } };
  } catch {
    return null;
  }
}

/** A position key that can exist: an address, a tick range inside v4's bounds, a 32-byte salt. */
export function isPositionKey(key: unknown): key is V4PositionKey {
  if (typeof key !== "object" || key === null) return false;
  const { owner, tickLower, tickUpper, salt } = key as Record<string, unknown>;
  return (
    typeof owner === "string" && isAddress(owner, { strict: false }) &&
    typeof tickLower === "number" && Number.isInteger(tickLower) && tickLower >= MIN_TICK &&
    typeof tickUpper === "number" && Number.isInteger(tickUpper) && tickUpper <= MAX_TICK && tickLower < tickUpper &&
    typeof salt === "string" && /^0x[0-9a-fA-F]{64}$/.test(salt)
  );
}

/** An address as an indexed event topic: left-padded to 32 bytes, lowercase. */
const topicOf = (address: string): Hex => `0x${lower(address).slice(2).padStart(64, "0")}`;
const keyId = (k: V4PositionKey): string => `${lower(k.owner)}:${k.tickLower}:${k.tickUpper}:${lower(k.salt)}`;

/**
 * The two token amounts that `liquidity` holds in the range [sqrtA, sqrtB] at the price `sqrtP` (all Q64.96 square-root
 * prices), in each currency's raw units, rounded down. Uniswap's LiquidityAmounts.getAmountsForLiquidity, step for step:
 * - at or below the range (sqrtP <= sqrtA) it is all currency0: L * 2^96 * (sqrtB - sqrtA) / sqrtB / sqrtA;
 * - at or above it (sqrtP >= sqrtB) it is all currency1: L * (sqrtB - sqrtA) / 2^96;
 * - inside, currency0 for the part of the range above the price and currency1 for the part below it.
 * The two divisions of amount0 are taken one after the other, as the library does (mulDiv, then a division), so the result
 * is the library's to the unit.
 */
export function amountsForLiquidity(sqrtP: bigint, sqrtA: bigint, sqrtB: bigint, liquidity: bigint): { amount0: bigint; amount1: bigint } {
  const [a, b] = sqrtA > sqrtB ? [sqrtB, sqrtA] : [sqrtA, sqrtB];
  if (a <= 0n) return { amount0: 0n, amount1: 0n };
  const amount0 = (from: bigint, to: bigint) => (liquidity * Q96 * (to - from)) / to / from;
  const amount1 = (from: bigint, to: bigint) => (liquidity * (to - from)) / Q96;
  if (sqrtP <= a) return { amount0: amount0(a, b), amount1: 0n };
  if (sqrtP >= b) return { amount0: 0n, amount1: amount1(a, b) };
  return { amount0: amount0(sqrtP, b), amount1: amount1(a, sqrtP) };
}

/** sqrt(2) with 30 decimals: a price that doubles moves its square root by this. */
const SQRT2_E30 = 1_414_213_562_373_095_048_801_688_724_209n;
const E30 = 10n ** 30n;

/**
 * A position in the quote currency alone, raw units, rounded down:
 * - `now`: the quote currency it holds at the pool's price, which is what removing it takes out in that currency;
 * - `inflow`: the quote currency buyers would pay into it while the TOKEN's price rises from the current price to twice
 *   it, which is its quote amount at the doubled price less `now` (the liquidity math is path-independent). The pool's
 *   raw price is currency1 per currency0, so when the token is currency0 the token's price doubling is the raw price
 *   doubling (its square root times sqrt 2), and when the token is currency1 it is the raw price halving (its square
 *   root divided by sqrt 2). A range the doubled price doesn't reach gains nothing; one the price has already left on
 *   the token's upside holds only quote and gains nothing more.
 * The token side has no part in either number.
 */
export function positionQuote(p: { sqrtPriceX96: bigint; tickLower: number; tickUpper: number; liquidity: bigint; quoteIsCurrency0: boolean }): { now: bigint; inflow: bigint } {
  if (p.sqrtPriceX96 <= 0n || p.liquidity <= 0n) return { now: 0n, inflow: 0n };
  const [lower, upper] = [sqrtRatioAtTick(p.tickLower), sqrtRatioAtTick(p.tickUpper)];
  const quoteAt = (sqrtP: bigint) => {
    const { amount0, amount1 } = amountsForLiquidity(sqrtP, lower, upper, p.liquidity);
    return p.quoteIsCurrency0 ? amount0 : amount1;
  };
  const doubled = p.quoteIsCurrency0 ? (p.sqrtPriceX96 * E30) / SQRT2_E30 : (p.sqrtPriceX96 * SQRT2_E30) / E30;
  const now = quoteAt(p.sqrtPriceX96);
  const then = quoteAt(doubled);
  return { now, inflow: then > now ? then - now : 0n };
}

/** What a constant-product (Uniswap v2) pair's quote reserve gains while the token's price doubles: reserve * (sqrt 2 - 1). */
export const v2Inflow = (quoteReserve: bigint): bigint => (quoteReserve * (SQRT2_E30 - E30)) / E30;

/**
 * Uniswap v4 reads a hook's permissions off its address (v4-core `src/libraries/Hooks.sol`). These three let it run code
 * when liquidity is removed: BEFORE_REMOVE_LIQUIDITY (1 << 9) and AFTER_REMOVE_LIQUIDITY (1 << 8) can revert the removal,
 * and AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA (1 << 0) can take some of what it pays out. A hook without them isn't called
 * on removal at all.
 */
const REMOVE_LIQUIDITY_FLAGS = (1n << 9n) | (1n << 8n) | (1n << 0n);
export const hookCanChangeRemoval = (key: PoolKey): boolean => (BigInt(key.hooks) & REMOVE_LIQUIDITY_FLAGS) !== 0n;

/** A v4 pool whose positions are to be read: its key, and which side is the quote currency with how many decimals. */
export type V4PoolRef = { poolId: Hex; key: PoolKey; quoteIsCurrency0: boolean; quoteDecimals: number };

/**
 * Why a pool's positions couldn't be read, each of which keeps lp-lock from passing or failing:
 * - `missing`: the index has no entry for the pool;
 * - `truncated`: it has more positions than the check reads;
 * - `stale`: the index's cursor is more than `TAIL_MAX_BLOCKS` behind the head;
 * - `mismatch`: the in-range positions don't add up to the pool's active liquidity: the index has a gap, and some
 *   position isn't in the list;
 * - `unreadable`: a list entry is malformed, or the pool's state, a position or an NFT's owner didn't answer.
 */
export type PoolGap = "missing" | "truncated" | "stale" | "mismatch" | "unreadable";

/** One position that holds liquidity: who can act on it, and what it is measured by in the quote currency (6 decimals). */
export type SizedPosition = {
  /** The position's owner in the PoolManager, or for a PositionManager position its NFT's owner. */
  holder: Address;
  /** The PositionManager NFT, when it is one. */
  tokenId: bigint | null;
  /** The quote currency it holds now, and what buyers would pay into it before the token's price doubles (`positionQuote`). */
  quote: bigint;
  inflow: bigint;
};

export type V4PoolRead = { pool: V4PoolRef } & ({ gap: PoolGap } | { gap: null; positions: SizedPosition[] });

/**
 * What `readV4Positions` found. `stale`: the index's cursor is too far behind for its tail to be read, so neither the
 * positions nor the list of the token's pools can be relied on. `unlisted`: v4 pools of the token against a quote
 * currency that were created after the cursor and that the caller didn't ask about: pools the lookup missed, whose
 * liquidity nothing here has read.
 */
export type V4PositionsRead = { pools: V4PoolRead[]; stale: boolean; unlisted: Hex[] };

/** The inspection's deadline passed before the liquidity-lock reads were done: what was read is not an answer. */
export class ReadsTimedOut extends Error {
  constructor() {
    super("The liquidity-lock reads ran out of time.");
    this.name = "ReadsTimedOut";
  }
}

/**
 * `work`, given up at `deadlineAt` (ms since the epoch, on Date.now()'s clock; undefined: never). Nothing is started at or
 * after the deadline, and an answer still missing at it is no longer waited for; either way it rejects with `ReadsTimedOut`.
 */
export function beforeDeadline<T>(deadlineAt: number | undefined, work: () => Promise<T>): Promise<T> {
  if (deadlineAt === undefined) return work();
  const left = deadlineAt - Date.now();
  if (left <= 0) return Promise.reject(new ReadsTimedOut());
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ReadsTimedOut()), left);
    work().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e as Error);
      },
    );
  });
}

async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** `calls` in aggregate3 batches of `BATCH`, all at `blockNumber`. Null when Multicall3 itself reverted: nothing was read. */
async function batched(reader: ChainReader, calls: readonly BatchCall[], blockNumber: bigint): Promise<BatchResult[] | null> {
  const chunks: BatchCall[][] = [];
  for (let i = 0; i < calls.length; i += BATCH) chunks.push(calls.slice(i, i + BATCH));
  try {
    return (await mapLimited(chunks, BATCH_CONCURRENCY, (chunk) => multicall(reader, chunk, { blockNumber }))).flat();
  } catch (e) {
    if (e instanceof CallReverted) return null;
    throw e;
  }
}

/**
 * The positions that hold liquidity in each of `pools`, each in the quote currency (`positionQuote`), or why they can't
 * be read (`PoolGap`), and the token's pools created since the index's cursor that aren't among them. Rejects on a
 * transport failure, and with `ReadsTimedOut` once `deadlineAt` passes. The steps are in the header comment; the numbers:
 * - `Initialize` over the blocks between the cursor and the head with `token` as currency0 and as currency1 (two
 *   eth_getLogs, whether or not there is a pool to read): a pool there against one of `quotes` that isn't in `pools` is
 *   `unlisted`; one that is in `pools` and has no entry in the index starts from an empty list, since every position
 *   of a pool created after the cursor is in the tail;
 * - the index's lists, then the positions `ModifyLiquidity` named over the same blocks (one eth_getLogs for all the
 *   pools, topic1 any of their ids), each key once;
 * - one round of multicalls at the head block for every pool's slot0 and active liquidity and every position's
 *   liquidity, then one more for `ownerOf` of the PositionManager positions that hold any;
 * - a position with no liquidity is dropped; one whose NFT has no owner while it holds liquidity makes the pool unreadable.
 */
export async function readV4Positions(a: {
  reader: ChainReader;
  v4: UniswapV4Config;
  pools: readonly V4PoolRef[];
  index: V4PositionIndex;
  /** The token inspected, and the currencies its pools are counted against (address(0) for the native one). */
  token: Address;
  quotes: readonly Address[];
  /** When the inspection stops waiting (ms since the epoch). */
  deadlineAt?: number;
}): Promise<V4PositionsRead> {
  const { reader, v4, pools, index, deadlineAt } = a;
  // A little behind the tip: the RPC sits behind a load balancer whose nodes can be a block apart, and a read pinned to a
  // block one of them doesn't have yet fails.
  const tip = await beforeDeadline(deadlineAt, () => reader.blockNumber());
  const head = tip > HEAD_MARGIN ? tip - HEAD_MARGIN : tip;
  const cursor = Number.isSafeInteger(index.cursor) && index.cursor >= 0 ? BigInt(index.cursor) : null;
  if (cursor === null || head - cursor > BigInt(TAIL_MAX_BLOCKS)) return { pools: pools.map((pool) => ({ pool, gap: "stale" })), stale: true, unlisted: [] };

  // The token's pools created since the cursor.
  const tail = { address: v4.poolManager, fromBlock: cursor + 1n, toBlock: head };
  const created = new Set<string>();
  if (cursor < head) {
    const token = topicOf(a.token);
    const [as0, as1] = await beforeDeadline(deadlineAt, () =>
      Promise.all([reader.logs({ ...tail, topics: [INITIALIZE_TOPIC, null, token] }), reader.logs({ ...tail, topics: [INITIALIZE_TOPIC, null, null, token] })]),
    );
    const quotes = new Set(a.quotes.map(topicOf));
    for (const [log, other] of [...as0.map((l) => [l, 3] as const), ...as1.map((l) => [l, 2] as const)]) {
      if (log.topics.length !== 4 || lower(log.topics[0]!) !== INITIALIZE_TOPIC || !quotes.has(lower(log.topics[other]!) as Hex)) continue;
      created.add(lower(log.topics[1]!));
    }
  }
  const asked = new Set(pools.map((pool) => lower(pool.poolId)));
  const unlisted = [...created].filter((id) => !asked.has(id)) as Hex[];

  // The lists, by pool. A pool the index has no entry for is missing, unless it was created after the cursor: then the
  // tail holds every one of its positions.
  const gaps = new Map<string, PoolGap>();
  const lists = new Map<string, Map<string, V4PositionKey>>();
  for (const pool of pools) {
    const id = lower(pool.poolId);
    const entry = Object.hasOwn(index.pools, id) ? index.pools[id] : undefined;
    if (!entry || !Array.isArray(entry.positions)) {
      if (created.has(id)) lists.set(id, new Map());
      else gaps.set(id, "missing");
      continue;
    }
    if (entry.truncated) gaps.set(id, "truncated");
    else if (!entry.positions.every(isPositionKey)) gaps.set(id, "unreadable");
    lists.set(id, new Map(entry.positions.filter(isPositionKey).map((key) => [keyId(key), key])));
  }
  const open = () => pools.filter((pool) => !gaps.has(lower(pool.poolId)));
  if (cursor < head && open().length > 0) {
    const logs = await beforeDeadline(deadlineAt, () => reader.logs({ ...tail, topics: [MODIFY_LIQUIDITY_TOPIC, open().map((pool) => pool.poolId)] }));
    for (const log of logs) {
      const found = positionFromLog(log);
      const list = found && lists.get(found.poolId);
      if (found && list && isPositionKey(found.key)) list.set(keyId(found.key), found.key);
    }
  }
  let budget = MAX_POSITIONS;
  for (const pool of open()) {
    const size = lists.get(lower(pool.poolId))!.size;
    if (size > MAX_POSITIONS_PER_POOL || size > budget) gaps.set(lower(pool.poolId), "truncated");
    else budget -= size;
  }

  // Round one: each pool's state and every position's liquidity, at the head block.
  const readable = open();
  const askedOf = readable.map((pool) => ({ pool, keys: [...lists.get(lower(pool.poolId))!.values()] }));
  const stateCalls = askedOf.flatMap(({ pool, keys }): BatchCall[] => [
    { target: v4.stateView, abi: positionInfoAbi, functionName: "getSlot0", args: [pool.poolId] },
    { target: v4.stateView, abi: positionInfoAbi, functionName: "getLiquidity", args: [pool.poolId] },
    ...keys.map((k): BatchCall => ({ target: v4.stateView, abi: positionInfoAbi, functionName: "getPositionInfo", args: [pool.poolId, k.owner, k.tickLower, k.tickUpper, k.salt] })),
  ]);
  const state = await beforeDeadline(deadlineAt, () => batched(reader, stateCalls, head));
  type Live = { key: V4PositionKey; quote: bigint; inflow: bigint; tokenId: bigint | null };
  const live = new Map<string, Live[]>();
  const positionManager = lower(v4.positionManager);
  let at = 0;
  for (const { pool, keys } of askedOf) {
    const id = lower(pool.poolId);
    const [slot0, active, infos] = state === null ? [undefined, undefined, []] : [state[at], state[at + 1], state.slice(at + 2, at + 2 + keys.length)];
    at += 2 + keys.length;
    if (!slot0?.ok || !active?.ok || infos.length !== keys.length || !infos.every((r) => r.ok)) {
      gaps.set(id, "unreadable");
      continue;
    }
    const [sqrtPriceX96, tick] = slot0.value as readonly [bigint, number, number, number];
    let inRange = 0n;
    const held: Live[] = [];
    keys.forEach((key, i) => {
      const [liquidity] = (infos[i] as { ok: true; value: unknown }).value as readonly [bigint, bigint, bigint];
      if (liquidity <= 0n) return;
      if (key.tickLower <= tick && tick < key.tickUpper) inRange += liquidity;
      const raw = positionQuote({ sqrtPriceX96, tickLower: key.tickLower, tickUpper: key.tickUpper, liquidity, quoteIsCurrency0: pool.quoteIsCurrency0 });
      held.push({
        key,
        quote: toSixDecimals(raw.now, pool.quoteDecimals),
        inflow: toSixDecimals(raw.inflow, pool.quoteDecimals),
        tokenId: lower(key.owner) === positionManager ? BigInt(key.salt) : null,
      });
    });
    // The pool's active liquidity is exactly the sum of the positions whose range holds the current tick. Anything else
    // means a position that isn't in the list (or one in it that isn't the pool's).
    if (sqrtPriceX96 <= 0n || inRange !== (active.value as bigint)) gaps.set(id, "mismatch");
    else live.set(id, held);
  }

  // Round two: who owns each NFT position that holds liquidity, at the same block.
  const nfts = [...live.values()].flat().filter((p) => p.tokenId !== null);
  const owners = await beforeDeadline(deadlineAt, () => batched(reader, nfts.map((p): BatchCall => ({ target: v4.positionManager, abi: erc721Abi, functionName: "ownerOf", args: [p.tokenId] })), head));
  const ownerOf = new Map<bigint, Address | null>(
    nfts.map((p, i) => {
      const answer = owners?.[i];
      return [p.tokenId!, answer?.ok && typeof answer.value === "string" && isAddress(answer.value, { strict: false }) ? (answer.value as Address) : null];
    }),
  );

  const read = pools.map((pool): V4PoolRead => {
    const id = lower(pool.poolId);
    const gap = gaps.get(id);
    if (gap) return { pool, gap };
    const positions: SizedPosition[] = [];
    for (const p of live.get(id) ?? []) {
      const holder = p.tokenId === null ? p.key.owner : ownerOf.get(p.tokenId);
      if (!holder) return { pool, gap: "unreadable" };
      positions.push({ holder, tokenId: p.tokenId, quote: p.quote, inflow: p.inflow });
    }
    return { pool, gap: null, positions };
  });
  return { pools: read, stale: false, unlisted };
}

/**
 * Who a holder of liquidity is, as far as the chain says:
 * - `burned`: a burn address, which nobody can act from;
 * - `locked`: one of the chain's known lock contracts (`knownLockers`);
 * - `wallet`: an address with no contract code, or an EIP-7702 wallet (its code is `0xef0100` and the address it
 *   delegates to: still a key that can sign a withdrawal);
 * - `contract`: any other contract. It may be a locker with terms of its own, a Safe, a launchpad or the pool's hook: its
 *   code decides who can withdraw and when, and this doesn't read that, so it is never called locked or withdrawable;
 * - `unclassified`: its code wasn't read (`code` is undefined), see `MAX_HOLDER_CODE_READS`.
 * This is the one place a holder is classified. A lock contract that has to be asked (ArcOS Vault's
 * `VaultFactory.isVault`, R2 Task 5) becomes one more answer in `context`, tested here before the code.
 */
export type HolderKind = "burned" | "locked" | "wallet" | "contract" | "unclassified";
export function classifyHolder(holder: Address, context: { knownLockers: readonly Address[]; code: Hex | null | undefined }): HolderKind {
  const address = lower(holder);
  if (BURN_ADDRESSES.some((burn) => lower(burn) === address)) return "burned";
  if (context.knownLockers.some((locker) => lower(locker) === address)) return "locked";
  if (context.code === undefined) return "unclassified";
  if (context.code === null || context.code === "0x" || isDelegation(context.code)) return "wallet";
  return "contract";
}

/** EIP-7702's delegation designator: 0xef0100 and a 20-byte address, 23 bytes in all. */
const isDelegation = (code: Hex): boolean => code.length === 2 + 23 * 2 && lower(code).startsWith("0xef0100");

/**
 * The code at the holders that need it to be classified (neither burned nor a known locker), the ones holding the most
 * first, at most `MAX_HOLDER_CODE_READS` of them. Keyed by lowercase address; a holder that isn't a key wasn't read.
 * Read at the latest block: an address gains code only by a deployment to it, which a few blocks don't change.
 */
export async function readHolderCode(
  reader: ChainReader,
  holders: readonly { holder: Address; value: bigint }[],
  knownLockers: readonly Address[],
  /** When the inspection stops waiting (ms since the epoch): past it this rejects with `ReadsTimedOut`. */
  deadlineAt?: number,
): Promise<Map<string, Hex | null>> {
  const totals = new Map<string, { holder: Address; value: bigint }>();
  for (const h of holders) {
    if (classifyHolder(h.holder, { knownLockers, code: undefined }) !== "unclassified") continue;
    const seen = totals.get(lower(h.holder));
    if (seen) seen.value += h.value;
    else totals.set(lower(h.holder), { holder: h.holder, value: h.value });
  }
  const top = [...totals.values()].sort((x, y) => (y.value > x.value ? 1 : y.value < x.value ? -1 : 0)).slice(0, MAX_HOLDER_CODE_READS);
  const codes = await beforeDeadline(deadlineAt, () => mapLimited(top, CODE_CONCURRENCY, (h) => reader.getCode(h.holder)));
  return new Map(top.map((h, i) => [lower(h.holder), codes[i] ?? null]));
}
