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
