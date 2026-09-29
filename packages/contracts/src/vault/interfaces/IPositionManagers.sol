// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// Uniswap v3 NonfungiblePositionManager: the calls the vault contracts make. Forks whose `positions()` tuple
/// differs (Aerodrome Slipstream) are not covered.
interface IV3PositionManager {
    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);
    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96,
            address,
            address token0,
            address token1,
            uint24,
            int24,
            int24,
            uint128,
            uint256,
            uint256,
            uint128,
            uint128
        );
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// Uniswap v4 PositionManager: the calls the vault contracts make. A currency is an address, and `address(0)` is the
/// native currency (USDC on Arc). Checked against the verified source of Arc's PositionManager
/// (`0x6049c9a0e26405C0985f9E3685C87d0aE917f82B`, v4-periphery, solc 0.8.26), whose runtime code is the same on
/// mainnet and testnet except for the chain id and the EIP-712 domain separator it caches.
interface IV4PositionManager {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function getPoolAndPositionInfo(uint256 tokenId) external view returns (PoolKey memory, uint256 info);
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
    function ownerOf(uint256 tokenId) external view returns (address);
}
