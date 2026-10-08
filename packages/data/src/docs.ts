import type { Address, NetworkId } from "@arcos/chain";
import type { Amount } from "./amounts";
import type { RadarFeedFilter } from "./names";
import type { TimestampLike } from "./timestamps";

// The doc types of design 1.6: one to one with the SQL tables of R1 Task 1 (columns in camelCase), plus the fields the
// design adds. Doc ids are <network>:<lowercase address> unless a type says otherwise (see ids.ts). Amounts are decimal
// strings (see Amount) and times are Timestamps, which the caller passes in. A value that can be absent is null and
// never undefined, because Firestore refuses undefined.

/** Which path found a token first (design 1.3, step 6). */
export type TokenSource = "factory" | "v2" | "v3" | "v4" | "aero";
export type PoolVersion = "v2" | "v3" | "v4" | "aero";
/** The quote side of a pool: the USDC ERC-20 view, native USDC (a v4 currency at address 0), or EURC. */
export type PoolQuote = "USDC" | "USDC-native" | "EURC";
/** Where a token stands in the inspection queue (design 1.3, step 8). */
export type InspectState = "queued" | "done" | "skipped";
export type AlertKind =
  | "owner_changed"
  | "supply_increased"
  | "paused"
  | "unpaused"
  | "implementation_changed"
  | "liquidity_dropped"
  | "lock_expiring";
export type DeliveryStatus = "pending" | "sent" | "failed";
export type DeliveryChannel = "telegram";

/** A Uniswap v4 pool key. Addresses are lowercase; the native currency is the zero address. */
export type V4PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };

/** The report summary a token doc carries, so a list never has to read the full report. */
export type ReportSummary = {
  passed: number;
  total: number;
  counts: { pass: number; warn: number; fail: number; unknown: number };
  block: number;
  at: TimestampLike;
};

/**
 * indexer/{network}: the cursor, the console controls and the run's lease. The owner edits `paused`, `inspect` and
 * `halted` in the Firebase console; the indexer never writes `paused` or `inspect`.
 */
export type IndexerDoc = {
  network: NetworkId;
  /** The last block whose logs were fully handled. Written last, so a crashed run repeats a window and never skips one. */
  block: number;
  updatedAt: TimestampLike;
  lastRunAt: TimestampLike | null;
  paused: boolean;
  /** Whether new tokens are queued for inspection. */
  inspect: boolean;
  /** Why the indexer stopped itself, or null. */
  halted: string | null;
  /** Blockscout calls spent on `day` (UTC, YYYY-MM-DD), against the daily budget. */
  explorerCalls: { day: string; count: number };
  /**
   * The lease of the run in progress: until when it holds the indexer, and which run it is. Set when a run starts and
   * cleared when it ends; a run that finds another's lease still live skips. Null between runs. The indexer writes both.
   */
  runningUntil: TimestampLike | null;
  runId: string | null;
};

/**
 * tokens/{network}:{address}. `A` is the amount type: `Amount` (a decimal string) in the stored doc, `bigint` in the
 * in-memory record.
 */
export type TokenFields<A> = {
  network: NetworkId;
  address: Address;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupply: A | null;
  source: TokenSource;
  creator: Address | null;
  firstBlock: number;
  firstSeen: TimestampLike;
  /** The deepest USDC or EURC pool; `id` is a pool id (see ids.ts), `depthUsdc` is in USDC's 6-decimal units. */
  bestPool: { id: string; version: PoolVersion; depthUsdc: A } | null;
  report: ReportSummary | null;
  /** Radar's filters, stored so a query never has to sort by depth: liquid is at least 1,000 USDC, passing is 5 checks or more. */
  radar: { liquid: boolean; passing: boolean };
  /**
   * The inspection queue (design 1.3, step 8). `priority` orders it, highest first, then the newest `firstSeen`
   * (see INSPECT_PRIORITY in names.ts); `queuedAt` is when the token last joined it, null once it left, and a token still queued 24
   * hours later is skipped.
   */
  inspect: { state: InspectState; priority: number; attempts: number; queuedAt: TimestampLike | null };
  launchpad: string | null;
};
export type TokenDoc = TokenFields<Amount>;
export type TokenRecord = TokenFields<bigint>;

/** pools/{network}:{poolId}. `poolId` is a pair or pool address, or a v4 pool id. */
export type PoolFields<A> = {
  network: NetworkId;
  poolId: string;
  version: PoolVersion;
  /** The non-quote side. */
  token: Address;
  quote: PoolQuote;
  fee: number | null;
  createdBlock: number;
  /** v4 only. */
  key: V4PoolKey | null;
  /** The last sampled depth in USDC's 6-decimal units. */
  depthUsdc: A | null;
  sampledAt: TimestampLike | null;
};
export type PoolDoc = PoolFields<Amount>;
export type PoolRecord = PoolFields<bigint>;

/** watchState/{network}:{token}: the last observed state of a watched token; an alert is a diff against it. */
export type WatchStateFields<A> = {
  network: NetworkId;
  token: Address;
  owner: Address | null;
  totalSupply: A | null;
  paused: boolean | null;
  implementation: Address | null;
  /** The pool id of the deepest pool. */
  bestPool: string | null;
  bestPoolDepth: A | null;
  checkedBlock: number;
  /** How many wallets watch the token. The doc is deleted when it reaches 0. */
  watchers: number;
  lastCheckedAt: TimestampLike;
};
export type WatchStateDoc = WatchStateFields<Amount>;
export type WatchStateRecord = WatchStateFields<bigint>;

/** reports/{network}:{address}. Expires after 90 days (TTL on expiresAt). */
export type ReportDoc<R = Record<string, unknown>> = {
  network: NetworkId;
  address: Address;
  block: number;
  passed: number;
  total: number;
  explorerReachable: boolean;
  degraded: boolean;
  /** The full inspector Report. Not indexed (see firestore/arcos.indexes.json). */
  report: R;
  createdAt: TimestampLike;
  expiresAt: TimestampLike;
};

/** users/{address} */
export type UserDoc = {
  address: Address;
  telegram: { chatId: number; linkedAt: TimestampLike } | null;
  createdAt: TimestampLike;
  lastSignInAt: TimestampLike;
  /**
   * A session cookie carries the version it was signed with, and counts only while it equals this one. Signing out adds
   * one, so every cookie issued before stops counting. A doc without it reads as 0.
   */
  sessionVersion: number;
};

/** watches/{user}:{network}:{token} */
export type WatchDoc = {
  user: Address;
  network: NetworkId;
  token: Address;
  createdAt: TimestampLike;
};

/** alerts/{auto id}. Expires after 90 days. */
export type AlertDoc = {
  network: NetworkId;
  token: Address;
  kind: AlertKind;
  /** Not indexed (see firestore/arcos.indexes.json). */
  detail: Record<string, unknown>;
  block: number;
  createdAt: TimestampLike;
  expiresAt: TimestampLike;
};

/** deliveries/{alert id}:{address}:telegram. Expires after 30 days. */
export type DeliveryDoc = {
  alertId: string;
  user: Address;
  channel: DeliveryChannel;
  status: DeliveryStatus;
  attempts: number;
  /** A short code, never a message. */
  error: string | null;
  createdAt: TimestampLike;
  deliveredAt: TimestampLike | null;
  expiresAt: TimestampLike;
};

/** nonces/{nonce}. Expires after 10 minutes. */
export type NonceDoc = { expiresAt: TimestampLike };

/** linkCodes/{code}. Expires after 10 minutes. */
export type LinkCodeDoc = { address: Address; expiresAt: TimestampLike };

/** One row of a Radar page (R1 Task 4's row fields). */
export type RadarRow = {
  address: Address;
  symbol: string | null;
  name: string | null;
  source: TokenSource;
  firstSeen: TimestampLike;
  passed: number | null;
  total: number | null;
  bestPoolDepth: Amount | null;
  /** null when the token didn't say; absent on rows written before R1 Task 4, read as null */
  decimals?: number | null;
  /** the factory caller the indexer recorded; null for tokens first seen through a pool; absent on older rows */
  creator?: Address | null;
};

/** radarFeed/{network}:{filter}: the first page of 50 rows, so one read serves a Radar page. */
export type RadarFeedDoc = {
  network: NetworkId;
  filter: RadarFeedFilter;
  /** Not indexed (see firestore/arcos.indexes.json). */
  rows: RadarRow[];
  updatedAt: TimestampLike;
};
