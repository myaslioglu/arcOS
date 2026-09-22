import type { NetworkId } from "./chains";

export type Address = `0x${string}`;

/** ERC-20 view (6 decimals) of the native USDC balance. Same address on both networks. */
export const USDC: Address = "0x3600000000000000000000000000000000000000";

export const EURC: Record<NetworkId, Address> = {
  mainnet: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1",
  testnet: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
};

export const BURN_ADDRESSES: Address[] = [
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dEaD",
];

export type DexConfig = {
  quoteTokens: { address: Address; symbol: string }[];
  v2Factory: Address;
  v3Factory: Address;
  v3FeeTiers: number[];
};

/**
 * Uniswap on Arc mainnet. Source: Uniswap sdk-core ARC_ADDRESSES; each address returned code
 * from rpc.mainnet.arc.io on 2026-09-20. Arc has no wrapped native token, so pools quote against
 * the USDC ERC-20 view. v4 and Aerodrome need an indexer (R1).
 */
export const DEX: Record<NetworkId, DexConfig | null> = {
  mainnet: {
    quoteTokens: [
      { address: USDC, symbol: "USDC" },
      { address: EURC.mainnet, symbol: "EURC" },
    ],
    v2Factory: "0x89e5db8b5aa49aa85ac63f691524311aeb649eba",
    v3Factory: "0xf0db7b58379503491d857db50ac9ece64c653918",
    v3FeeTiers: [100, 500, 3000, 10000],
  },
  testnet: null,
};

/** Lock contracts whose token holdings count as locked. 4rc.OS Vault joins this list in R2. */
export const KNOWN_LOCKERS: Record<NetworkId, Address[]> = { mainnet: [], testnet: [] };

export type ArcosContracts = { feeController: Address; tokenFactory: Address; multisend: Address };

/**
 * Our own deployments. null until deployed on that network.
 * Testnet: deployed 2026-09-22; each contract's `feeController()` was read back on chain and matches.
 */
export const ARCOS: Record<NetworkId, ArcosContracts | null> = {
  mainnet: null,
  testnet: {
    feeController: "0xC470753e83c151a6A4A360869270291A6ED70d99",
    tokenFactory: "0x41FaFc54ED3be1545695B82af4aA490607447884",
    multisend: "0x113f3864C94ff6a14310a789bD671de5b78D6CBf",
  },
};
