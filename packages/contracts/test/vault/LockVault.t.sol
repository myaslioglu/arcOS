// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LockVault} from "../../src/vault/LockVault.sol";
import {MockToken, MockBlockableToken, MockReentrantOwnerToken} from "./mocks/VaultMocks.sol";

/// Tests the vault on its own: each vault here is a clone of a fresh implementation that the test initialises
/// itself, so nothing depends on VaultFactory.
contract LockVaultTest is Test {
    LockVault internal impl;
    MockToken internal token;
    address internal owner = makeAddr("owner");
    address internal next = makeAddr("next");
    address internal stranger = makeAddr("stranger");
    address internal recipient = makeAddr("recipient");
    uint64 internal unlockAt;

    function setUp() public {
        impl = new LockVault();
        token = new MockToken();
        unlockAt = uint64(block.timestamp + 30 days);
    }

    function _clone(IERC20 token_, address owner_, uint64 unlockAt_) internal returns (LockVault v) {
        v = LockVault(Clones.clone(address(impl)));
        v.initialize(owner_, token_, unlockAt_);
    }

    function _vault() internal returns (LockVault) {
        return _clone(token, owner, unlockAt);
    }

    function _funded(uint256 amount) internal returns (LockVault v) {
        v = _vault();
        token.mint(address(v), amount);
    }

    // ---------------------------------------------------------------------
    // initialize
    // ---------------------------------------------------------------------

    function test_implementation_cannotBeInitialised() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(owner, token, unlockAt);
    }

    function test_initialize_setsStateAndEmitsInitialized() public {
        LockVault v = LockVault(Clones.clone(address(impl)));
        vm.expectEmit(false, false, false, true, address(v));
        emit Initializable.Initialized(1);
        v.initialize(owner, token, unlockAt);
        assertEq(v.owner(), owner);
        assertEq(address(v.token()), address(token));
        assertEq(v.unlockAt(), unlockAt);
        assertEq(v.pendingOwner(), address(0));
        assertEq(v.MAX_DURATION(), 3650 days);
    }

    function test_initialize_cannotBeCalledTwice() public {
        LockVault v = _vault();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        v.initialize(owner, token, unlockAt);
        vm.prank(owner);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        v.initialize(stranger, token, unlockAt + 1);
        assertEq(v.owner(), owner);
        assertEq(v.unlockAt(), unlockAt);
    }

    function test_initialize_rejectsZeroOwner() public {
        LockVault v = LockVault(Clones.clone(address(impl)));
        vm.expectRevert(LockVault.ZeroAddress.selector);
        v.initialize(address(0), token, unlockAt);
    }

    function test_initialize_unlockTimeMustBeInTheFutureAndWithinMaxDuration() public {
        uint64 nowTs = uint64(block.timestamp);
        LockVault bad = LockVault(Clones.clone(address(impl)));
        vm.expectRevert(LockVault.BadUnlockTime.selector);
        bad.initialize(owner, token, nowTs); // not after now
        vm.expectRevert(LockVault.BadUnlockTime.selector);
        bad.initialize(owner, token, nowTs - 1);
        vm.expectRevert(LockVault.BadUnlockTime.selector);
        bad.initialize(owner, token, nowTs + 3650 days + 1); // past MAX_DURATION
        vm.expectRevert(LockVault.BadUnlockTime.selector);
        bad.initialize(owner, token, type(uint64).max);

        assertEq(_clone(token, owner, nowTs + 1).unlockAt(), nowTs + 1); // one second is a lock
        assertEq(_clone(token, owner, nowTs + 3650 days).unlockAt(), nowTs + 3650 days); // exactly MAX_DURATION
    }

    // ---------------------------------------------------------------------
    // lockedAmount
    // ---------------------------------------------------------------------

    function test_lockedAmount_isTheLiveBalance() public {
        LockVault v = _vault();
        assertEq(v.lockedAmount(), 0);
        token.mint(address(v), 5 ether);
        assertEq(v.lockedAmount(), 5 ether);
        token.mint(address(v), 7 ether);
        assertEq(v.lockedAmount(), 12 ether);
    }

    // ---------------------------------------------------------------------
    // withdraw
    // ---------------------------------------------------------------------

    function test_withdraw_revertsOneSecondBeforeUnlock_andSucceedsAtUnlock() public {
        LockVault v = _funded(100 ether);
        vm.warp(unlockAt - 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(LockVault.StillLocked.selector, unlockAt));
        v.withdraw(recipient);
        assertEq(token.balanceOf(address(v)), 100 ether);

        vm.warp(unlockAt);
        vm.prank(owner);
        v.withdraw(recipient);
        assertEq(token.balanceOf(recipient), 100 ether);
    }

    function test_withdraw_sendsTheWholeBalance_toTheChosenAddress_andEmits() public {
        LockVault v = _funded(100 ether);
        vm.warp(unlockAt);
        vm.expectEmit(true, false, false, true, address(v));
        emit LockVault.Withdrawn(recipient, 100 ether);
        vm.prank(owner);
        v.withdraw(recipient);
        assertEq(token.balanceOf(recipient), 100 ether);
        assertEq(token.balanceOf(address(v)), 0);
        assertEq(token.balanceOf(owner), 0); // it goes where the owner points, not to the owner by default
    }

    function test_withdraw_rejectsZeroRecipient() public {
        LockVault v = _funded(1 ether);
        vm.warp(unlockAt);
        vm.prank(owner);
        vm.expectRevert(LockVault.ZeroAddress.selector);
        v.withdraw(address(0));
        assertEq(token.balanceOf(address(v)), 1 ether);
    }

    function test_withdraw_isOwnerOnly() public {
        LockVault v = _funded(1 ether);
        vm.warp(unlockAt);

        vm.prank(stranger);
        vm.expectRevert(LockVault.NotOwner.selector);
        v.withdraw(stranger);

        vm.prank(owner);
        v.transferOwnership(next);
        vm.prank(next); // a pending owner has no power yet
        vm.expectRevert(LockVault.NotOwner.selector);
        v.withdraw(next);

        vm.prank(next);
        v.acceptOwnership();
        vm.prank(owner); // the ex-owner has none any more
        vm.expectRevert(LockVault.NotOwner.selector);
        v.withdraw(owner);

        assertEq(token.balanceOf(address(v)), 1 ether);
    }

    function test_withdraw_canRunAgain_forTokensThatArriveLater() public {
        LockVault v = _funded(10 ether);
        vm.warp(unlockAt);
        vm.prank(owner);
        v.withdraw(recipient);
        token.mint(address(v), 3 ether); // a late donation, an airdrop
        vm.prank(owner);
        v.withdraw(recipient);
        assertEq(token.balanceOf(recipient), 13 ether);
        assertEq(token.balanceOf(address(v)), 0);
    }

    function test_withdraw_withNothingHeld_isHarmless() public {
        LockVault v = _vault();
        vm.warp(unlockAt);
        vm.expectEmit(true, false, false, true, address(v));
        emit LockVault.Withdrawn(recipient, 0);
        vm.prank(owner);
        v.withdraw(recipient);
        assertEq(token.balanceOf(recipient), 0);
    }

    function test_withdraw_toABlockedAddress_reverts_andTheOwnerCanChooseAnother() public {
        MockBlockableToken blk = new MockBlockableToken();
        LockVault v = _clone(blk, owner, unlockAt);
        blk.mint(address(v), 50 ether);
        blk.setBlocked(recipient, true);
        vm.warp(unlockAt);

        vm.prank(owner);
        vm.expectRevert("blocked");
        v.withdraw(recipient);
        assertEq(blk.balanceOf(address(v)), 50 ether); // nothing left the vault

        vm.prank(owner);
        v.withdraw(next);
        assertEq(blk.balanceOf(next), 50 ether);
    }

    function test_withdraw_isNotReentrant() public {
        MockReentrantOwnerToken re = new MockReentrantOwnerToken();
        LockVault v = _clone(re, address(re), unlockAt); // the token is the owner, so the nested call passes onlyOwner
        re.mint(address(v), 10 ether);
        re.arm(v);
        vm.warp(unlockAt);

        re.withdrawFromVault(recipient);

        assertEq(re.balanceOf(recipient), 10 ether);
        assertEq(re.balanceOf(address(v)), 0);
        assertEq(re.seen(), abi.encodeWithSelector(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector));
    }

    // ---------------------------------------------------------------------
    // extend
    // ---------------------------------------------------------------------

    function test_extend_onlyLengthens_andEmits() public {
        LockVault v = _vault();
        vm.startPrank(owner);
        vm.expectRevert(LockVault.BadUnlockTime.selector);
        v.extend(unlockAt); // the same time is not longer
        vm.expectRevert(LockVault.BadUnlockTime.selector);
        v.extend(unlockAt - 1);
        vm.expectEmit(false, false, false, true, address(v));
        emit LockVault.Extended(unlockAt + 1);
        v.extend(unlockAt + 1);
        vm.stopPrank();
        assertEq(v.unlockAt(), unlockAt + 1);
    }

    function test_extend_isBoundedByMaxDuration() public {
        LockVault v = _vault();
        uint64 max = uint64(block.timestamp + 3650 days);
        vm.startPrank(owner);
        vm.expectRevert(LockVault.BadUnlockTime.selector);
        v.extend(max + 1);
        v.extend(max);
        vm.stopPrank();
        assertEq(v.unlockAt(), max);

        // The bound moves with the clock: a day later, a day more is allowed.
        vm.warp(block.timestamp + 1 days);
        vm.prank(owner);
        v.extend(max + 1 days);
        assertEq(v.unlockAt(), max + 1 days);
    }

    function test_extend_onlyOwner() public {
        LockVault v = _vault();
        vm.prank(stranger);
        vm.expectRevert(LockVault.NotOwner.selector);
        v.extend(unlockAt + 1);

        vm.prank(owner);
        v.transferOwnership(next);
        vm.prank(next);
        vm.expectRevert(LockVault.NotOwner.selector);
        v.extend(unlockAt + 1);
        assertEq(v.unlockAt(), unlockAt);
    }

    function test_extend_afterExpiry_canRelock_butNotIntoThePast() public {
        LockVault v = _funded(10 ether);
        vm.warp(unlockAt + 100 days);
        uint64 nowTs = uint64(block.timestamp);
        vm.startPrank(owner);
        // Later than the old unlock time, but already over: that is not a lock.
        vm.expectRevert(LockVault.BadUnlockTime.selector);
        v.extend(unlockAt + 1 days);
        vm.expectRevert(LockVault.BadUnlockTime.selector);
        v.extend(nowTs);
        // A future time locks the vault again.
        v.extend(nowTs + 7 days);
        vm.expectRevert(abi.encodeWithSelector(LockVault.StillLocked.selector, nowTs + 7 days));
        v.withdraw(recipient);
        vm.stopPrank();
        assertEq(token.balanceOf(address(v)), 10 ether);
    }

    // ---------------------------------------------------------------------
    // Two-step ownership
    // ---------------------------------------------------------------------

    function test_transferOwnership_isTwoStep() public {
        LockVault v = _vault();
        vm.expectEmit(true, true, false, false, address(v));
        emit LockVault.OwnershipTransferStarted(owner, next);
        vm.prank(owner);
        v.transferOwnership(next);
        assertEq(v.owner(), owner); // nothing moves until the new owner accepts
        assertEq(v.pendingOwner(), next);

        vm.expectEmit(true, true, false, false, address(v));
        emit LockVault.OwnershipTransferred(owner, next);
        vm.prank(next);
        v.acceptOwnership();
        assertEq(v.owner(), next);
        assertEq(v.pendingOwner(), address(0));
    }

    function test_transferOwnership_ownerOnly_andCanBeCancelledOrReplaced() public {
        LockVault v = _vault();
        vm.prank(stranger);
        vm.expectRevert(LockVault.NotOwner.selector);
        v.transferOwnership(stranger);

        vm.startPrank(owner);
        v.transferOwnership(next);
        v.transferOwnership(address(0)); // cancels
        vm.stopPrank();
        assertEq(v.pendingOwner(), address(0));
        vm.prank(next);
        vm.expectRevert(LockVault.NotPendingOwner.selector);
        v.acceptOwnership();

        vm.startPrank(owner);
        v.transferOwnership(next);
        v.transferOwnership(stranger); // replaces
        vm.stopPrank();
        vm.prank(next);
        vm.expectRevert(LockVault.NotPendingOwner.selector);
        v.acceptOwnership();
        vm.prank(stranger);
        v.acceptOwnership();
        assertEq(v.owner(), stranger);
    }

    function test_acceptOwnership_onlyThePendingOwner() public {
        LockVault v = _vault();
        // Nothing pending: nobody can accept.
        vm.prank(stranger);
        vm.expectRevert(LockVault.NotPendingOwner.selector);
        v.acceptOwnership();
        vm.prank(owner);
        vm.expectRevert(LockVault.NotPendingOwner.selector);
        v.acceptOwnership();

        vm.prank(owner);
        v.transferOwnership(next);
        vm.prank(stranger);
        vm.expectRevert(LockVault.NotPendingOwner.selector);
        v.acceptOwnership();
        vm.prank(owner); // the owner is not the pending owner either
        vm.expectRevert(LockVault.NotPendingOwner.selector);
        v.acceptOwnership();
        assertEq(v.owner(), owner);
    }

    function test_oldOwnerLosesEverythingAfterAccept() public {
        LockVault v = _funded(1 ether);
        vm.prank(owner);
        v.transferOwnership(next);
        vm.prank(next);
        v.acceptOwnership();
        vm.warp(unlockAt);

        vm.startPrank(owner);
        vm.expectRevert(LockVault.NotOwner.selector);
        v.extend(unlockAt + 1 days);
        vm.expectRevert(LockVault.NotOwner.selector);
        v.withdraw(owner);
        vm.expectRevert(LockVault.NotOwner.selector);
        v.transferOwnership(owner);
        vm.stopPrank();

        vm.prank(next);
        v.withdraw(next);
        assertEq(token.balanceOf(next), 1 ether);
    }

    // ---------------------------------------------------------------------
    // No other way in
    // ---------------------------------------------------------------------

    function test_vaultRejectsNativeValueAndUnknownCalls() public {
        LockVault v = _vault();
        (bool sentValue,) = address(v).call{value: 0}("");
        assertFalse(sentValue); // no receive() and no fallback(), even for an empty call
        vm.deal(address(this), 1 ether);
        (bool sentEther,) = address(v).call{value: 1}("");
        assertFalse(sentEther);
        (bool unknown,) = address(v).call(hex"deadbeef");
        assertFalse(unknown);
        assertEq(address(v).balance, 0);
    }

    // ---------------------------------------------------------------------
    // Fuzz
    // ---------------------------------------------------------------------

    function testFuzz_withdraw_neverBeforeUnlock(uint64 duration, uint64 elapsed) public {
        duration = uint64(bound(duration, 1, 3650 days));
        elapsed = uint64(bound(elapsed, 0, 4000 days));
        LockVault v = _clone(token, owner, uint64(block.timestamp + duration));
        token.mint(address(v), 1 ether);
        uint64 at = v.unlockAt();
        vm.warp(block.timestamp + elapsed);

        vm.prank(owner);
        if (elapsed < duration) {
            vm.expectRevert(abi.encodeWithSelector(LockVault.StillLocked.selector, at));
            v.withdraw(recipient);
            assertEq(token.balanceOf(recipient), 0);
            assertEq(token.balanceOf(address(v)), 1 ether);
        } else {
            v.withdraw(recipient);
            assertEq(token.balanceOf(recipient), 1 ether);
            assertEq(token.balanceOf(address(v)), 0);
        }
    }

    function testFuzz_strangerCanCallNothing(address caller, uint256 t, address to, uint64 skip) public {
        vm.assume(caller != owner && caller != address(0)); // nobody can send from the zero address
        LockVault v = _funded(1 ether);
        vm.warp(block.timestamp + bound(skip, 0, 400 days)); // before and after unlock alike
        uint64 newTime = uint64(bound(t, block.timestamp + 1, block.timestamp + 3650 days));

        vm.startPrank(caller);
        vm.expectRevert(LockVault.NotOwner.selector);
        v.extend(newTime);
        vm.expectRevert(LockVault.NotOwner.selector);
        v.withdraw(to);
        vm.expectRevert(LockVault.NotOwner.selector);
        v.transferOwnership(to);
        vm.expectRevert(LockVault.NotPendingOwner.selector);
        v.acceptOwnership();
        vm.stopPrank();

        assertEq(v.owner(), owner);
        assertEq(v.pendingOwner(), address(0));
        assertEq(v.unlockAt(), unlockAt);
        assertEq(token.balanceOf(address(v)), 1 ether);
    }

    function testFuzz_extend_neverShortens(uint256 newTime, uint64 skip) public {
        LockVault v = _vault();
        vm.warp(block.timestamp + bound(skip, 0, 400 days));
        uint64 before = v.unlockAt();
        uint64 candidate = uint64(bound(newTime, 0, block.timestamp + 4000 days));

        vm.prank(owner);
        try v.extend(candidate) {
            assertEq(v.unlockAt(), candidate);
            assertGt(candidate, before);
            assertGt(candidate, block.timestamp);
            assertLe(candidate, block.timestamp + 3650 days);
        } catch {
            assertEq(v.unlockAt(), before);
        }
        assertGe(v.unlockAt(), before);
    }
}
