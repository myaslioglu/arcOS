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
