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

/** Uniswap v4's contracts. `poolManager` holds the tokens of every v4 pool; `stateView` and `quoter` are what Inspector reads. */
export type UniswapV4Config = { poolManager: Address; positionManager: Address; stateView: Address; quoter: Address };

/** Aerodrome Slipstream (concentrated liquidity). `tickSpacings` are the ones the factory has enabled. */
export type AerodromeConfig = { clFactory: Address; positionManager: Address; tickSpacings: number[] };

/**
 * Which pools Inspector reads on a network. Uniswap v2 and v3 exist on mainnet only (testnet has neither), so those
 * fields are optional; `v4` and `aero` are absent where the network has no such contracts. A missing block means
 * "not scanned here", never "scanned and empty".
 */
export type DexConfig = {
  quoteTokens: { address: Address; symbol: string }[];
  v2Factory?: Address;
  v3Factory?: Address;
  v3FeeTiers?: number[];
  v4?: UniswapV4Config;
  aero?: AerodromeConfig;
};

/** Multicall3, at its canonical address on both networks. Inspector batches its v4 and Aerodrome reads through it. */
export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

/**
 * Uniswap v4 on Arc: the same addresses on mainnet and testnet. `eth_getCode` on both networks on 2026-09-29:
 * PoolManager 24,009 bytes, PositionManager 23,877, StateView 3,531, V4Quoter 6,118; the PositionManager, StateView and
 * V4Quoter each answer `poolManager()` with the PoolManager below (`eth_call`, both networks, 2026-09-29).
 */
export const UNISWAP_V4: UniswapV4Config = {
  poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  positionManager: "0x6049c9a0e26405C0985f9E3685C87d0aE917f82B",
  stateView: "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b",
  quoter: "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94",
};

/**
 * Aerodrome Slipstream on Arc mainnet (testnet has no code at either address). `eth_getCode` on 2026-09-29: factory 9,492
 * bytes, position manager 24,516 bytes (its `factory()` is the factory below).
 * `tickSpacings` come from the factory's own `tickSpacings()` view, read on 2026-09-29 as [1, 50, 100, 200, 2000, 10]
 * and sorted here. The factory's owner can enable more, so the live suite compares this list with the view.
 */
export const AERODROME: AerodromeConfig = {
  clFactory: "0xb89Df768aF2CFE637ceB352c587Fe8edAf491d03",
  positionManager: "0xc84bB45D43CD25D02b83B4C085eaA4e08da8f473",
  tickSpacings: [1, 10, 50, 100, 200, 2000],
};

/**
 * Pools on Arc, per network. Mainnet: Uniswap v2 and v3 (Uniswap sdk-core ARC_ADDRESSES; each address returned code from
 * rpc.mainnet.arc.io on 2026-09-20), v4 and Aerodrome. Testnet: v4 only. Arc has no wrapped native token, so pools quote
 * against the USDC ERC-20 view (on v4 also against native USDC, whose currency is address(0)).
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
    v4: UNISWAP_V4,
    aero: AERODROME,
  },
  testnet: {
    quoteTokens: [
      { address: USDC, symbol: "USDC" },
      { address: EURC.testnet, symbol: "EURC" },
    ],
    v4: UNISWAP_V4,
  },
};

/** Lock contracts whose token holdings count as locked. 4rc.OS Vault joins this list in R2. */
export const KNOWN_LOCKERS: Record<NetworkId, Address[]> = { mainnet: [], testnet: [] };

export type ArcosContracts = { feeController: Address; tokenFactory: Address; multisend: Address };

/**
 * Our own deployments. null until deployed on that network.
 * Verify a TokenFactory's source on the explorer BEFORE wiring it here: the Inspector counts every token it created
 * as source-verified through it (`checkVerified` in @arcos/inspector).
 * Mainnet: deployed 2026-09-25 from 8b9eb2a; each contract's `feeController()` was read back on chain and matches, and
 * the runtime bytecode equals that commit's build (immutables masked).
 * Testnet: deployed 2026-09-22; each contract's `feeController()` was read back on chain and matches.
 */
export const ARCOS: Record<NetworkId, ArcosContracts | null> = {
  mainnet: {
    feeController: "0x2B37F9a9443B2DfaE6B7C7063586935a574B5699",
    tokenFactory: "0xa68edD822048C00dC816d93005B72F8a50234a24",
    multisend: "0x03ddE90Fde3983CEEE600dbc9b76f6D73512af47",
  },
  testnet: {
    feeController: "0xC470753e83c151a6A4A360869270291A6ED70d99",
    tokenFactory: "0x41FaFc54ED3be1545695B82af4aA490607447884",
    multisend: "0x113f3864C94ff6a14310a789bD671de5b78D6CBf",
  },
};
