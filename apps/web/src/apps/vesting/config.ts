import type { NetworkId } from "@arcos/chain";

/**
 * The block VestingFactory was deployed in, per network: the lower bound when the window searches for the block a wallet
 * was created in, to learn its token (which the wallet itself doesn't keep). Null searches from block 0, which costs
 * only a few more steps. Set it with `ARCOS[network].vestingFactory` when the factory is deployed.
 */
export const VESTING_FROM_BLOCK: Record<NetworkId, bigint | null> = { mainnet: null, testnet: null };
