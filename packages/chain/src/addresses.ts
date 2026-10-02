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

/**
 * Uniswap's Permit2, at its canonical address, the same on every chain. On Arc it has 9,152 bytes of code on both
 * networks, and `DOMAIN_SEPARATOR()` and `allowance(address,address,address)` answer (read 2026-09-30 from
 * rpc.mainnet.arc.io and rpc.testnet.arc.io).
 */
export const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/**
 * Uniswap's Universal Routers on Arc: the spenders a swap's approvals and Permit2 allowances name. Checked 2026-09-30:
 * each has code (24,546 and 24,380 bytes) and its `poolManager()` returns the v4 PoolManager
 * `0x8366a39CC670B4001A1121B8F6A443A643e40951`. The second has no code on testnet.
 */
export const UNIVERSAL_ROUTERS: Record<NetworkId, Address[]> = {
  mainnet: ["0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1", "0x8702463e73f74d0b6765aBceb314Ef07aCb92650"],
  testnet: ["0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1"],
};

/** Lock contracts whose token holdings count as locked. 4rc.OS Vault joins this list in R2. */
export const KNOWN_LOCKERS: Record<NetworkId, Address[]> = { mainnet: [], testnet: [] };

export type ArcosContracts = {
  feeController: Address;
  tokenFactory: Address;
  multisend: Address;
  /** R1 (packages/contracts/script/DeployR1.s.sol). Absent or null until deployed on that network. */
  vaultFactory?: Address | null;
  vestingFactory?: Address | null;
  proPass?: Address | null;
};

/**
 * Our own deployments. null until deployed on that network.
 * Verify a TokenFactory's source on the explorer BEFORE wiring it here: the Inspector counts every token it created
 * as source-verified through it (`checkVerified` in @arcos/inspector).
 * Mainnet: deployed 2026-09-25 from 8b9eb2a; each contract's `feeController()` was read back on chain and matches, and
 * the runtime bytecode equals that commit's build (immutables masked).
 * Testnet: deployed 2026-09-22; each contract's `feeController()` was read back on chain and matches.
 * R1's contracts (vaultFactory, vestingFactory, proPass) go on testnet first, through DeployR1 (DEPLOY.md, "R1"); they
 * stay null until then, and null on mainnet.
 */
export const ARCOS: Record<NetworkId, ArcosContracts | null> = {
  mainnet: {
    feeController: "0x2B37F9a9443B2DfaE6B7C7063586935a574B5699",
    tokenFactory: "0xa68edD822048C00dC816d93005B72F8a50234a24",
    multisend: "0x03ddE90Fde3983CEEE600dbc9b76f6D73512af47",
    vaultFactory: null,
    vestingFactory: null,
    proPass: null,
  },
  testnet: {
    feeController: "0xC470753e83c151a6A4A360869270291A6ED70d99",
    tokenFactory: "0x41FaFc54ED3be1545695B82af4aA490607447884",
    multisend: "0x113f3864C94ff6a14310a789bD671de5b78D6CBf",
    vaultFactory: null,
    vestingFactory: null,
    proPass: null,
  },
};
