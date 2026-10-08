import type { NetworkId } from "@arcos/chain";

/** The named Firestore database arcOS reads and writes: the only database this package ever addresses. */
export const DATABASE_ID = "arcos";

/** Names another database, for tests. Nothing sets it in a deployment. */
export const DATABASE_ENV = "ARCOS_FIRESTORE_DATABASE";

// A Record over NetworkId stops compiling the day @arcos/chain gains or drops a network, until this list follows.
const NETWORK_FLAGS: Record<NetworkId, true> = { mainnet: true, testnet: true };
export const NETWORKS: readonly NetworkId[] = Object.keys(NETWORK_FLAGS) as NetworkId[];

export function isNetwork(value: unknown): value is NetworkId {
  return typeof value === "string" && Object.hasOwn(NETWORK_FLAGS, value);
}

/** Collection ids: the SQL tables of R1 Task 1 as design 1.6 maps them, plus linkCodes and radarFeed. */
export const COLLECTIONS = {
  indexer: "indexer",
  tokens: "tokens",
  pools: "pools",
  reports: "reports",
  users: "users",
  watches: "watches",
  watchState: "watchState",
  alerts: "alerts",
  deliveries: "deliveries",
  nonces: "nonces",
  linkCodes: "linkCodes",
  radarFeed: "radarFeed",
} as const;
export type CollectionKey = keyof typeof COLLECTIONS;
export type CollectionName = (typeof COLLECTIONS)[CollectionKey];

/** The four first-page feeds of `radarFeed/{network}:{filter}`. */
export const RADAR_FEED_FILTERS = ["all", "liquid", "passing", "liquid-passing"] as const;
export type RadarFeedFilter = (typeof RADAR_FEED_FILTERS)[number];

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Every TTL field is named expiresAt. Firestore deletes expired docs within about a day, so code checks expiry too. */
export const TTL_FIELD = "expiresAt";

/** How long a doc lives after it is written, per collection with a TTL policy (design 1.6). */
export const TTL_MS = {
  nonces: 10 * MINUTE,
  linkCodes: 10 * MINUTE,
  alerts: 90 * DAY,
  deliveries: 30 * DAY,
  reports: 90 * DAY,
} as const satisfies Partial<Record<CollectionKey, number>>;
export type TtlCollection = keyof typeof TTL_MS;
export const TTL_COLLECTIONS = Object.keys(TTL_MS) as TtlCollection[];

/**
 * tokens.inspect.priority: the inspection queue takes the highest first, then the newest `firstSeen` (design 1.3, step
 * 8: liquid first, then newest). Liquidity is only known once a token has been inspected, so "liquid first" means a
 * token whose last report found it liquid, queued again because a new pool appeared. Then a token with a USDC or EURC
 * pool, then one without (a TokenFactory token nobody has paired yet).
 */
export const INSPECT_PRIORITY = { liquid: 2, pooled: 1, bare: 0 } as const;

/** A token still queued this long after it joined the queue is skipped; it is inspected when someone opens it. */
export const INSPECT_QUEUE_MAX_AGE_MS = DAY;

/** How many rows a radarFeed doc holds: one Radar page. */
export const RADAR_FEED_SIZE = 50;

/** Radar's "at least 5 checks pass" (tokens.radar.passing), R1's filter. */
export const RADAR_PASSING_MIN = 5;

/** The most pools /api/pools and the indexer hand an inspection: the Inspector reads at most 50 index pools. */
export const INDEXED_POOLS_LIMIT = 50;

/** How many tokens a wallet may watch (Watchdog's free tier). Enforced in addWatch's transaction. */
export const FREE_WATCH_LIMIT = 3;

/** A delivery is tried this many times in all: the first try plus at most 3 retries on later runs. */
export const DELIVERY_MAX_ATTEMPTS = 4;

/** A delivery still pending this long after it was created is failed as "expired" instead of being sent. */
export const DELIVERY_MAX_AGE_MS = DAY;

/**
 * When a drop in the deepest pool's depth is an alert: both at least 30% of the previous depth (bps of 10,000) and at
 * least 500 units of the quote currency (6 decimals), so neither a thin pool's noise nor a deep pool's dust alerts.
 */
export const LIQUIDITY_DROP = { bps: 3000n, minUnits: 500_000_000n } as const;
