// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title PositionVault (placeholder)
/// @notice Stands in for the concentrated-liquidity position vault so that `VaultFactory` compiles against its final
/// type. `initialize` always reverts, so this build cannot create a position lock. The real contract replaces this
/// file and keeps `Kind` and the `initialize` signature.
contract PositionVault {
    /// @dev V3 is Uniswap v3 only. Forks whose `positions()` tuple differs (Aerodrome Slipstream) are not covered.
    enum Kind {
        V3,
        V4
    }

    error NotImplemented();

    function initialize(address, address, uint256, uint64, Kind, uint16, address payable) external pure {
        revert NotImplemented();
    }

    receive() external payable {
        revert NotImplemented();
    }
}
