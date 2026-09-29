import type { Address, NetworkId } from "@arcos/chain";
import type { DeliveryChannel } from "./docs";
import { DataError } from "./errors";
import { RADAR_FEED_FILTERS, isNetwork, type RadarFeedFilter } from "./names";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const V4_POOL_ID = /^0x[0-9a-fA-F]{64}$/;
const ALERT_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function assertNetwork(value: string): NetworkId {
  if (!isNetwork(value)) throw new DataError("network", 'Not a network: expected "mainnet" or "testnet"');
  return value;
}

/** A wallet or contract address, lowercased: the form every doc id and address field uses. */
export function normalizeAddress(value: string): Address {
  if (typeof value !== "string" || !ADDRESS.test(value)) {
    throw new DataError("address", "Not an address: expected 0x and 40 hex digits");
  }
  return value.toLowerCase() as Address;
}

/** A pair or pool address, or a Uniswap v4 pool id (32 bytes of hex, which is not an address), lowercased. */
export function normalizePoolId(value: string): string {
  if (typeof value === "string" && (ADDRESS.test(value) || V4_POOL_ID.test(value))) return value.toLowerCase();
  throw new DataError("pool-id", "Not a pool id: expected an address, or a v4 pool id of 0x and 64 hex digits");
}

/** tokens/, reports/ and watchState/ share this id (the token address); pools/ uses `poolId` in its place. */
export const tokenId = (network: NetworkId, address: string): string => `${assertNetwork(network)}:${normalizeAddress(address)}`;

export const poolId = (network: NetworkId, id: string): string => `${assertNetwork(network)}:${normalizePoolId(id)}`;

export const userId = (address: string): Address => normalizeAddress(address);

/** watches/{user}:{network}:{token}: the id is the unique constraint, so one wallet cannot watch a token twice. */
export const watchId = (user: string, network: NetworkId, token: string): string =>
  `${normalizeAddress(user)}:${assertNetwork(network)}:${normalizeAddress(token)}`;

/** deliveries/{alert id}:{address}:telegram. The alert id is Firestore's own, so it must not carry a colon or a slash. */
export function deliveryId(alertId: string, user: string, channel: DeliveryChannel = "telegram"): string {
  if (typeof alertId !== "string" || !ALERT_ID.test(alertId)) {
    throw new DataError("alert-id", "Not an alert id: expected 1 to 128 letters, digits, - or _");
  }
  return `${alertId}:${normalizeAddress(user)}:${channel}`;
}

/** Which of the four radarFeed docs a token belongs in, from its two stored flags. */
export function radarFeedFilter(flags: { liquid: boolean; passing: boolean }): RadarFeedFilter {
  if (flags.liquid && flags.passing) return "liquid-passing";
  if (flags.liquid) return "liquid";
  return flags.passing ? "passing" : "all";
}

export function radarFeedId(network: NetworkId, filter: RadarFeedFilter): string {
  if (!(RADAR_FEED_FILTERS as readonly string[]).includes(filter)) {
    throw new DataError("radar-filter", "Not a radar feed: expected all, liquid, passing or liquid-passing");
  }
  return `${assertNetwork(network)}:${filter}`;
}
