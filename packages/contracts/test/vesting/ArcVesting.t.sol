// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {VestingWallet} from "@openzeppelin/contracts/finance/VestingWallet.sol";
import {VestingWalletCliff} from "@openzeppelin/contracts/finance/VestingWalletCliff.sol";
import {stdError} from "forge-std/StdError.sol";
import {ArcVesting} from "../../src/vesting/ArcVesting.sol";
import {VestingTestBase} from "./VestingTestBase.sol";
import {MockFeeOnTransferToken, MockRebasingToken} from "../vault/mocks/VaultMocks.sol";
import {MockNativeMirrorUsdc} from "./mocks/VestingMocks.sol";

/// The wallet itself: OpenZeppelin's linear vesting with a cliff, and the one thing ArcVesting changes about it
/// (the native-value path is closed, because on Arc USDC's native balance and its ERC-20 balance are one balance).
contract ArcVestingTest is VestingTestBase {
    uint256 internal constant AMOUNT = 1_200 ether;

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    function test_constructor_setsTheScheduleAndTheBeneficiaryAsOwner() public {
        uint64 start = uint64(block.timestamp + 7 days);
        ArcVesting w = new ArcVesting(bob, start, 365 days, 30 days);
        assertEq(w.owner(), bob);
        assertEq(w.start(), start);
        assertEq(w.duration(), 365 days);
        assertEq(w.cliff(), start + 30 days, "cliff() is a timestamp: start + cliff seconds");
        assertEq(w.end(), start + 365 days);
    }

    function test_constructor_rejectsAZeroBeneficiary() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new ArcVesting(address(0), uint64(block.timestamp), 365 days, 0);
    }

    function test_constructor_rejectsACliffLongerThanTheDuration() public {
        vm.expectRevert(
            abi.encodeWithSelector(VestingWalletCliff.InvalidCliffDuration.selector, uint64(366 days), uint64(365 days))
        );
        new ArcVesting(bob, uint64(block.timestamp), 365 days, 366 days);
    }

    // ---------------------------------------------------------------------
    // The curve
    // ---------------------------------------------------------------------

    function test_nothingIsReleasableBeforeTheCliff() public {
        ArcVesting w = _createStandard(AMOUNT);
        assertEq(w.releasable(address(token)), 0, "at start");
        vm.warp(w.cliff() - 1);
        assertEq(w.releasable(address(token)), 0, "one second before the cliff");
        assertEq(w.vestedAmount(address(token), uint64(w.cliff() - 1)), 0);
        uint256 before = token.balanceOf(bob);
        w.release(address(token));
        assertEq(token.balanceOf(bob), before, "a release before the cliff moves nothing");
        assertEq(w.released(address(token)), 0);
    }

    function test_atTheCliff_theWholeTimeSinceStartVestsAtOnce() public {
        ArcVesting w = _createStandard(AMOUNT);
        vm.warp(w.cliff());
        assertEq(w.releasable(address(token)), (AMOUNT * 90 days) / 365 days);
    }

    function test_afterTheCliff_vestingIsLinear_andRoundsDown() public {
        ArcVesting w = _create(alice, token, bob, 1_000, uint64(block.timestamp), 3, 0);
        vm.warp(block.timestamp + 1);
        assertEq(w.releasable(address(token)), 333, "1000 * 1 / 3 = 333.3, rounded down");
        vm.warp(block.timestamp + 1);
        assertEq(w.releasable(address(token)), 666, "1000 * 2 / 3 = 666.6, rounded down");
        vm.warp(block.timestamp + 1);
        assertEq(w.releasable(address(token)), 1_000, "everything at the end");
    }

    function test_halfWay_halfIsReleasable_andReleaseSendsItToTheBeneficiary() public {
        ArcVesting w = _createStandard(AMOUNT);
        vm.warp(w.start() + 365 days / 2);
        uint256 expected = (AMOUNT * (365 days / 2)) / 365 days;
        assertEq(w.releasable(address(token)), expected);

        uint256 before = token.balanceOf(bob);
        vm.expectEmit(true, false, false, true, address(w));
        emit VestingWallet.ERC20Released(address(token), expected);
        vm.prank(stranger); // anyone may trigger a release; the tokens always go to the owner
        w.release(address(token));
        assertEq(token.balanceOf(bob) - before, expected);
        assertEq(w.released(address(token)), expected);
        assertEq(w.releasable(address(token)), 0, "nothing more until time passes");
        assertEq(token.balanceOf(stranger), 0);
    }

    function test_everythingAtTheEnd_andNothingMoreAfterIt() public {
        ArcVesting w = _createStandard(AMOUNT);
        vm.warp(w.start() + 200 days);
        w.release(address(token));
        vm.warp(w.end());
        assertEq(w.releasable(address(token)), AMOUNT - w.released(address(token)));
        w.release(address(token));
        assertEq(w.released(address(token)), AMOUNT);
        assertEq(token.balanceOf(address(w)), 0);
        vm.warp(w.end() + 3650 days);
        assertEq(w.releasable(address(token)), 0);
    }

    function test_aStartInTheFuture_nothingVestsBeforeIt() public {
        uint64 start = uint64(block.timestamp + 30 days);
        ArcVesting w = _create(alice, token, bob, AMOUNT, start, 100 days, 0);
        vm.warp(start - 1);
        assertEq(w.releasable(address(token)), 0);
        vm.warp(start + 50 days);
        assertEq(w.releasable(address(token)), AMOUNT / 2);
    }

    function test_aStartInThePast_theElapsedPartIsReleasableAtOnce() public {
        uint64 start = uint64(block.timestamp - 50 days);
        ArcVesting w = _create(alice, token, bob, AMOUNT, start, 100 days, 10 days);
        assertEq(w.releasable(address(token)), AMOUNT / 2);
    }

    function test_aCliffEqualToTheDuration_isAPlainTimelock() public {
        ArcVesting w = _create(alice, token, bob, AMOUNT, uint64(block.timestamp), 100 days, 100 days);
        vm.warp(w.end() - 1);
        assertEq(w.releasable(address(token)), 0);
        vm.warp(w.end());
        assertEq(w.releasable(address(token)), AMOUNT);
    }

    /// Tokens that arrive after creation follow the same schedule, as if they had been there from the start.
    function test_aDonation_followsTheSchedule() public {
        ArcVesting w = _createStandard(AMOUNT);
        vm.prank(alice);
        assertTrue(token.transfer(address(w), AMOUNT));
        vm.warp(w.start() + 365 days / 2);
        assertEq(w.releasable(address(token)), (2 * AMOUNT * (365 days / 2)) / 365 days);
    }

    // ---------------------------------------------------------------------
    // Ownership: OpenZeppelin's own warning, pinned
    // ---------------------------------------------------------------------

    /// VestingWallet is `Ownable(beneficiary)`. The beneficiary can hand the wallet, unvested tokens included, to
    /// anyone, in one step, and so can sell it. From then on every release pays the new owner.
    function test_theBeneficiaryCanTransferTheWallet_unvestedTokensIncluded() public {
        ArcVesting w = _createStandard(AMOUNT);
        vm.prank(bob);
        w.transferOwnership(carol);
        assertEq(w.owner(), carol);
        vm.warp(w.end());
        uint256 bobBefore = token.balanceOf(bob);
        w.release(address(token));
        assertEq(token.balanceOf(carol), AMOUNT, "the buyer receives everything");
        assertEq(token.balanceOf(bob), bobBefore, "the original beneficiary receives nothing");
    }

    function test_onlyTheOwnerCanTransferTheWallet() public {
        ArcVesting w = _createStandard(AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice); // the creator has no power over the wallet
        w.transferOwnership(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vm.prank(stranger);
        w.renounceOwnership();
    }

    /// Renouncing is disabled (THREAT-MODEL V2, decided 2026-10-02): it would leave no owner to pay, so every later
    /// release would revert and the tokens would stay in the wallet for good. It reverts for the owner and changes
    /// nothing: releases keep paying the owner, and the wallet can still be transferred.
    function test_renounceOwnership_alwaysReverts_releasesStillPayTheOwner() public {
        ArcVesting w = _createStandard(AMOUNT);
        vm.prank(bob);
        vm.expectRevert(ArcVesting.RenounceDisabled.selector);
        w.renounceOwnership();
        assertEq(w.owner(), bob);

        vm.warp(w.end());
        uint256 before = token.balanceOf(bob);
        w.release(address(token));
        assertEq(token.balanceOf(bob) - before, AMOUNT);
        assertEq(token.balanceOf(address(w)), 0);

        vm.prank(bob);
        w.transferOwnership(carol);
        vm.prank(carol);
        vm.expectRevert(ArcVesting.RenounceDisabled.selector);
        w.renounceOwnership();
        assertEq(w.owner(), carol);
    }

    // ---------------------------------------------------------------------
    // Native value: closed on Arc
    // ---------------------------------------------------------------------

    function test_nativeValueIsRefused() public {
        ArcVesting w = _createStandard(AMOUNT);
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok, bytes memory data) = address(w).call{value: 1 ether}("");
        assertFalse(ok, "the wallet accepted native value");
        assertEq(data, abi.encodeWithSelector(ArcVesting.NativeValueNotSupported.selector));
        assertEq(address(w).balance, 0);
    }

    function test_nativeRelease_isClosed_andNothingNativeIsReleasable() public {
        ArcVesting w = _createStandard(AMOUNT);
        vm.deal(address(w), 10 ether); // forced in, e.g. by selfdestruct, or by USDC's ERC-20 view on Arc
        vm.warp(w.end());
        assertEq(w.releasable(), 0);
        vm.expectRevert(ArcVesting.NativeValueNotSupported.selector);
        w.release();
        assertEq(address(w).balance, 10 ether);
    }

    /// On Arc, USDC is one balance with two views. Vest it through its ERC-20 view and the same tokens also show up as
    /// the wallet's native balance. OpenZeppelin tracks the two views separately, so with both release paths open
    /// the beneficiary could take the ERC-20 half way through and then the native "half" of what is left: more than
    /// has vested. OpenZeppelin's NatSpec warns of exactly this and says to disable one path.
    function test_usdcsTwoViews_cannotBeReleasedTwice() public {
        MockNativeMirrorUsdc usdc = new MockNativeMirrorUsdc();
        uint256 amount = 1_000e6;
        vm.deal(alice, 10_000 ether + amount * 1e12);
        vm.prank(alice);
        usdc.approve(address(factory), type(uint256).max);
        ArcVesting w = _create(alice, IERC20(address(usdc)), bob, amount, uint64(block.timestamp), 100 days, 0);
        assertEq(address(w).balance, amount * 1e12, "the ERC-20 view's tokens are the wallet's native balance");
        assertEq(w.vestedAmount(uint64(block.timestamp + 100 days)), 0, "the native view reports nothing as vested");

        vm.warp(w.start() + 50 days);
        uint256 bobBefore = usdc.balanceOf(bob);
        w.release(address(usdc));
        try w.release() {} catch {}
        uint256 gained = usdc.balanceOf(bob) - bobBefore;
        assertEq(gained, amount / 2, "the beneficiary took more than has vested");
    }

    // ---------------------------------------------------------------------
    // Awkward tokens
    // ---------------------------------------------------------------------

    /// A taxed token: the wallet releases by its own books, and the token takes its cut on the way out.
    function test_feeOnTransfer_theWalletReleasesItsBalance_theTokenTaxesTheExit() public {
        MockFeeOnTransferToken taxed = new MockFeeOnTransferToken(100); // 1%
        taxed.mint(alice, 10_000 ether);
        vm.prank(alice);
        taxed.approve(address(factory), type(uint256).max);
        ArcVesting w = _create(alice, IERC20(address(taxed)), bob, 1_000 ether, uint64(block.timestamp), 100 days, 0);
        assertEq(taxed.balanceOf(address(w)), 990 ether);
        vm.warp(w.end());
        w.release(address(taxed));
        assertEq(w.released(address(taxed)), 990 ether);
        assertEq(taxed.balanceOf(bob), 980.1 ether);
        assertEq(taxed.balanceOf(address(w)), 0);
    }

    /// OpenZeppelin computes what has vested from the live balance plus what was released. After a release, a
    /// negative rebase can make that smaller than what was already released: `releasable` then underflows and every
    /// release reverts until the balance recovers or the schedule ends. Pinned so the threat model sees it.
    function test_negativeRebase_canBlockReleasesUntilTheEnd() public {
        MockRebasingToken reb = new MockRebasingToken();
        reb.mint(alice, 10_000 ether);
        vm.prank(alice);
        reb.approve(address(factory), type(uint256).max);
        ArcVesting w = _create(alice, IERC20(address(reb)), bob, 1_000 ether, uint64(block.timestamp), 100 days, 0);
        vm.warp(w.start() + 80 days);
        w.release(address(reb)); // 800 released, 200 left
        reb.rebase(0.5e18); // the wallet now holds 100
        vm.warp(w.start() + 90 days); // vested = (100 + 800) * 90% = 810 > 800: still fine
        assertEq(w.releasable(address(reb)), 10 ether);
        reb.rebase(0.1e18); // the wallet now holds 20; vested = 820 * 90% = 738 < 800
        vm.expectRevert(stdError.arithmeticError);
        w.releasable(address(reb));
        vm.expectRevert(stdError.arithmeticError);
        w.release(address(reb));
        vm.warp(w.end()); // at the end everything held is releasable again
        w.release(address(reb));
        assertEq(reb.balanceOf(address(w)), 0);
    }
}
