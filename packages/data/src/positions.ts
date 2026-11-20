import { DEX, type Address, type NetworkId } from "@arcos/chain";
import type { PositionDoc, PositionKey } from "./docs";
import { normalizeAddress } from "./ids";

/**
 * The doc for a position a `ModifyLiquidity` log named in `block`: the key, lowercased, and the PositionManager NFT's
 * id when the PositionManager holds the position (its salt is then `bytes32(tokenId)`). Everything in it comes from the
 * key and the block, so the same log always gives the same doc.
 */
export function positionDoc(network: NetworkId, poolId: string, key: { owner: string; tickLower: number; tickUpper: number; salt: string }, block: number): PositionDoc {
  const owner = normalizeAddress(key.owner);
  const salt = key.salt.toLowerCase();
  const positionManager = DEX[network]?.v4?.positionManager.toLowerCase();
  return {
    network,
    poolId: poolId.toLowerCase(),
    owner,
    tickLower: key.tickLower,
    tickUpper: key.tickUpper,
    salt,
    tokenId: owner === positionManager ? BigInt(salt).toString() : null,
    firstBlock: block,
  };
}

/** A stored position as the Inspector's position key. */
export const positionKey = (doc: Pick<PositionDoc, "owner" | "tickLower" | "tickUpper" | "salt">): PositionKey => ({
  owner: doc.owner as Address,
  tickLower: doc.tickLower,
  tickUpper: doc.tickUpper,
  salt: doc.salt as `0x${string}`,
});
