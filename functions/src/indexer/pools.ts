import { EURC, USDC, type Address, type NetworkId } from "@arcos/chain";
import type { PoolQuote, PoolRecord, PoolVersion } from "@arcos/data";
import type { PoolSighting } from "./events";

const NATIVE = "0x0000000000000000000000000000000000000000";

/**
 * Which quote currency an address is, for a pool of `version` on `network` (design 1.3, step 6): USDC's ERC-20 view at
 * 0x3600…, EURC, or on Uniswap v4 also native USDC, the currency at address(0). Anything else is null.
 */
export function quoteOf(currency: string, version: PoolVersion, network: NetworkId): PoolQuote | null {
  const address = currency.toLowerCase();
  if (address === USDC.toLowerCase()) return "USDC";
  if (address === EURC[network].toLowerCase()) return "EURC";
  if (version === "v4" && address === NATIVE) return "USDC-native";
  return null;
}

/** A pool worth recording, and the token it trades. */
export type Selected = { pool: PoolRecord; token: Address };

/**
 * The pool and token a sighting adds to the index: only a pool with a quote currency on exactly one side, whose other
 * side becomes the token. A pool of two quotes (USDC/EURC, or native USDC against its ERC-20 view) has no token to index.
 */
export function selectPool(sighting: PoolSighting, network: NetworkId): Selected | null {
  const q0 = quoteOf(sighting.currency0, sighting.version, network);
  const q1 = quoteOf(sighting.currency1, sighting.version, network);
  if ((q0 === null) === (q1 === null)) return null;
  const quote = (q0 ?? q1) as PoolQuote;
  const token = (q0 === null ? sighting.currency0 : sighting.currency1).toLowerCase() as Address;
  let key: PoolRecord["key"] = null;
  if (sighting.version === "v4") {
    if (sighting.fee === null || sighting.tickSpacing === null || sighting.hooks === null) return null;
    key = { currency0: sighting.currency0, currency1: sighting.currency1, fee: sighting.fee, tickSpacing: sighting.tickSpacing, hooks: sighting.hooks };
  }
  return {
    token,
    pool: {
      network,
      poolId: sighting.id,
      version: sighting.version,
      token,
      quote,
      fee: sighting.fee,
      createdBlock: sighting.block,
      key,
      depthUsdc: null,
      sampledAt: null,
    },
  };
}
