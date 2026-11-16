import { UNISWAP_V4, type Address } from "./addresses";
import type { NetworkId } from "./chains";

// Kept apart from addresses.ts, which other work changes too.

/** A liquidity position manager: the ERC-721 contract whose tokens are a DEX's pool positions. */
export type PositionManagerInfo = { address: Address; name: string };

/**
 * The position managers Vault and Finder look for a wallet's positions in. Only a candidate here that the VaultFactory
 * allows (`managers(address)` answers `allowed`, with the kind the factory gives it) is ever used: the factory keeps
 * its allow-list as that per-address view and its `ManagerSet` events, with no view that lists every manager, so the
 * app asks it about each known candidate. A manager allowed but not listed here can still be typed into Vault.
 *
 * - Uniswap v3's NonfungiblePositionManager, mainnet only (testnet has no Uniswap v3: no code at that address there).
 *   Read on rpc.mainnet.arc.io on 2026-11-16: 24,384 bytes of code, `factory()` is DEX.mainnet.v3Factory, `name()` is
 *   "Uniswap V3 Positions NFT-V1", and it answers `supportsInterface(0x780e9d63)` (ERC721Enumerable) with true.
 * - Uniswap v4's PositionManager, the same address on both networks (UNISWAP_V4). It is not ERC721Enumerable:
 *   `supportsInterface(0x780e9d63)` is false on both networks (2026-11-16) and `tokenOfOwnerByIndex` reverts.
 *
 * Aerodrome's Slipstream manager is left out: its `positions()` differs from v3's, and the vault contracts take
 * Uniswap v3 and v4 positions only (PositionVault.Kind).
 */
export const POSITION_MANAGERS: Record<NetworkId, PositionManagerInfo[]> = {
  mainnet: [
    { address: "0x39654A85A4C05127f5Fd6ED22CAeC077A0fB1377", name: "Uniswap v3" },
    { address: UNISWAP_V4.positionManager, name: "Uniswap v4" },
  ],
  testnet: [{ address: UNISWAP_V4.positionManager, name: "Uniswap v4" }],
};
