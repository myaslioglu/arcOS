import { amountFromString, amountToString } from "./amounts";
import type {
  PoolDoc,
  PoolFields,
  PoolRecord,
  TokenDoc,
  TokenFields,
  TokenRecord,
  V4PoolKey,
  WatchStateDoc,
  WatchStateFields,
  WatchStateRecord,
} from "./docs";
import { assertNetwork, normalizeAddress, normalizePoolId } from "./ids";

// The pure half of the converters. A record is what the app handles (amounts as bigint); a doc is what Firestore holds
// (amounts as decimal strings). Timestamps are never built here: the caller passes them in, real Timestamps or not, and
// they come out as they went in. Each collection has one mapper used in both directions, so to and from cannot disagree.
// Every field is copied by name, so a stray property on a record never reaches Firestore, and every id and address is
// validated and lowercased on the way.

function opt<A, B>(value: A | null, convert: (input: A) => B): B | null {
  return value === null ? null : convert(value);
}

function mapToken<A, B>(token: TokenFields<A>, amount: (input: A) => B): TokenFields<B> {
  return {
    network: assertNetwork(token.network),
    address: normalizeAddress(token.address),
    name: token.name,
    symbol: token.symbol,
    decimals: token.decimals,
    totalSupply: opt(token.totalSupply, amount),
    source: token.source,
    creator: opt(token.creator, normalizeAddress),
    firstBlock: token.firstBlock,
    firstSeen: token.firstSeen,
    bestPool: opt(token.bestPool, (pool) => ({
      id: normalizePoolId(pool.id),
      version: pool.version,
      depthUsdc: amount(pool.depthUsdc),
    })),
    report: opt(token.report, (report) => ({
      passed: report.passed,
      total: report.total,
      counts: {
        pass: report.counts.pass,
        warn: report.counts.warn,
        fail: report.counts.fail,
        unknown: report.counts.unknown,
      },
      block: report.block,
      at: report.at,
    })),
    radar: { liquid: token.radar.liquid, passing: token.radar.passing },
    inspect: { state: token.inspect.state, priority: token.inspect.priority, attempts: token.inspect.attempts },
    launchpad: token.launchpad,
  };
}

const mapKey = (key: V4PoolKey): V4PoolKey => ({
  currency0: normalizeAddress(key.currency0),
  currency1: normalizeAddress(key.currency1),
  fee: key.fee,
  tickSpacing: key.tickSpacing,
  hooks: normalizeAddress(key.hooks),
});

function mapPool<A, B>(pool: PoolFields<A>, amount: (input: A) => B): PoolFields<B> {
  return {
    network: assertNetwork(pool.network),
    poolId: normalizePoolId(pool.poolId),
    version: pool.version,
    token: normalizeAddress(pool.token),
    quote: pool.quote,
    fee: pool.fee,
    createdBlock: pool.createdBlock,
    key: opt(pool.key, mapKey),
    depthUsdc: opt(pool.depthUsdc, amount),
    sampledAt: pool.sampledAt,
  };
}

function mapWatchState<A, B>(state: WatchStateFields<A>, amount: (input: A) => B): WatchStateFields<B> {
  return {
    network: assertNetwork(state.network),
    token: normalizeAddress(state.token),
    owner: opt(state.owner, normalizeAddress),
    totalSupply: opt(state.totalSupply, amount),
    paused: state.paused,
    implementation: opt(state.implementation, normalizeAddress),
    bestPool: opt(state.bestPool, normalizePoolId),
    bestPoolDepth: opt(state.bestPoolDepth, amount),
    checkedBlock: state.checkedBlock,
    watchers: state.watchers,
    lastCheckedAt: state.lastCheckedAt,
  };
}

export const tokenToDoc = (token: TokenRecord): TokenDoc => mapToken(token, amountToString);
export const tokenFromDoc = (doc: TokenDoc): TokenRecord => mapToken(doc, amountFromString);

export const poolToDoc = (pool: PoolRecord): PoolDoc => mapPool(pool, amountToString);
export const poolFromDoc = (doc: PoolDoc): PoolRecord => mapPool(doc, amountFromString);

export const watchStateToDoc = (state: WatchStateRecord): WatchStateDoc => mapWatchState(state, amountToString);
export const watchStateFromDoc = (doc: WatchStateDoc): WatchStateRecord => mapWatchState(doc, amountFromString);
