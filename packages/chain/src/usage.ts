import type { Address } from "./addresses";
import type { NetworkId } from "./chains";

// What the Stats counter reads on chain: where counting begins, the Multisends Drop has used, and the events it counts.
// Kept apart from addresses.ts, which other work changes too.

/**
 * Multisends Drop used before the one in `ARCOS[network].multisend`. Drop's sendToken approves the Multisend, so a
 * token approved to an earlier one stays approved until revoked; Revoke names these so that allowance can be found, and
 * Stats counts their `Drop` events with the current Multisend's.
 * Mainnet's first Multisend (deployed 2026-09-25) was Drop's until 2026-10-30 (packages/contracts/DEPLOY.md,
 * "Deployments").
 */
export const PREVIOUS_MULTISENDS: Record<NetworkId, Address[]> = {
  mainnet: ["0x03ddE90Fde3983CEEE600dbc9b76f6D73512af47"],
  testnet: [],
};

/**
 * The block Stats starts counting at, and its date (UTC): the block that deployed mainnet's FeeController, the first of
 * ArcOS's contracts. Its three `KeyAdded` events (MINT_FLAT, DROP_PER_RECIPIENT and DROP_MIN, 158, 226 and 262 blocks
 * later) seed the fee timeline before the TokenFactory (315 blocks after it) and the first Multisend (420 blocks after it)
 * can emit anything. Found on 2026-11-08 as the first block with code at 0x2B37...5699 (`eth_getCode` by binary search on
 * rpc.mainnet.arc.io: block 22,742,796, timestamp 1790367245). Null where Stats keeps no count: testnet numbers are not
 * counted.
 */
export const STATS_FROM: Record<NetworkId, { block: number; at: string } | null> = {
  mainnet: { block: 22_742_796, at: "2026-09-25" },
  testnet: null,
};

/**
 * The events behind each on-chain number, as signatures, for the public JSON that says how to check them. A test
 * compares each with the ABI, so a contract change can't leave a stale line here.
 */
export const USAGE_EVENTS = {
  tokenCreated: "TokenCreated(address,address,address,string,string,uint8,uint256,uint256,bool,bool)",
  drop: "Drop(address,address,uint256,uint256,uint256,uint256)",
} as const;
