// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {VestingWallet} from "@openzeppelin/contracts/finance/VestingWallet.sol";
import {VestingWalletCliff} from "@openzeppelin/contracts/finance/VestingWalletCliff.sol";

/// @title ArcVesting
/// @notice OpenZeppelin's audited linear vesting with a cliff, for ERC-20 tokens. One wallet per schedule. Nothing
/// vests before `cliff()`; from then on `amount * (now - start) / duration` has vested, rounded down, and everything
/// has vested at `end()`. Anyone may call `release(token)`, and the tokens always go to the wallet's owner. Nobody
/// else can release or redirect them, and there is no admin.
/// @dev The one change to OpenZeppelin's contract: the native-value path is closed. On Arc, USDC is one balance
/// with two views (native, 18 decimals, and ERC-20 at 0x3600..., 6 decimals), so USDC vested through its ERC-20 view
/// is also this wallet's native balance. OpenZeppelin keeps separate books for the two views, and its own NatSpec
/// warns that on such a chain the beneficiary can release the same asset through both and take more than has
/// vested. So `receive` refuses value, `release()` always reverts and `releasable()` is always zero. Native value that
/// arrives anyway (USDC's ERC-20 view, `selfdestruct`) is released through `release(token)` in its ERC-20 view.
///
/// WARNING (OpenZeppelin's own): the wallet is `Ownable(beneficiary)` and ownership moves in one step, so the
/// beneficiary can transfer, and so sell, the wallet with its unvested tokens. Readers must treat `owner()` as the
/// beneficiary, not the address the wallet was created for. `renounceOwnership` leaves no one to pay, and every
/// later release then reverts: the tokens stay in the wallet for good.
///
/// What has vested is computed from the wallet's live balance plus what it has released, so tokens sent after
/// creation follow the same schedule. A token that rebases down after a release can make that total smaller than
/// what was released; `releasable` then reverts until the balance recovers or the schedule ends. A token that takes
/// a cut on transfer takes it on the way out too.
contract ArcVesting is VestingWalletCliff {
    error NativeValueNotSupported();

    /// @dev Reverts `OwnableInvalidOwner` for a zero beneficiary and `InvalidCliffDuration` for a cliff longer than
    /// the duration. `cliffSeconds` is counted from `start`.
    constructor(address beneficiary, uint64 start, uint64 duration, uint64 cliffSeconds)
        VestingWallet(beneficiary, start, duration)
        VestingWalletCliff(cliffSeconds)
    {}

    /// @notice Refuses native value: see the contract's note on USDC's two views.
    receive() external payable override {
        revert NativeValueNotSupported();
    }

    /// @notice Always reverts: this wallet releases ERC-20 tokens only, with `release(token)`.
    function release() public pure override {
        revert NativeValueNotSupported();
    }

    /// @notice Always zero: nothing is releasable as native value.
    function releasable() public pure override returns (uint256) {
        return 0;
    }
}
