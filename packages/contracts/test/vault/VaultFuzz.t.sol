// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {LockVault} from "../../src/vault/LockVault.sol";
import {VaultFactory} from "../../src/vault/VaultFactory.sol";
import {VaultTestBase} from "./VaultTestBase.sol";
import {MockToken} from "./mocks/VaultMocks.sol";

/// Fuzz tests over the whole lock path: any amount, any duration, any clock, any caller.
contract VaultFuzzTest is VaultTestBase {
    using SafeCast for uint256;

    uint64 internal constant MAX_DURATION = 3650 days;

    /// A fresh token holding exactly `amount` for `user`, approved to the factory, so amounts can span all of uint256.
    function _freshToken(address user, uint256 amount) internal returns (MockToken t) {
        t = new MockToken();
        t.mint(user, amount);
        vm.prank(user);
        t.approve(address(factory), type(uint256).max);
    }

    function testFuzz_lockThenWithdraw_roundTrip(uint256 amount, uint64 duration, uint64 elapsed) public {
        amount = bound(amount, 1, type(uint256).max);
        duration = uint64(bound(duration, 1, MAX_DURATION));
        elapsed = uint64(bound(elapsed, 0, 4000 days));
        MockToken t = _freshToken(alice, amount);
        uint256 recipientBefore = feeRecipient.balance;

        LockVault v = _lock(alice, IERC20(address(t)), amount, duration, alice);
        assertEq(t.balanceOf(address(v)), amount);
        assertEq(t.balanceOf(alice), 0);
        assertEq(feeRecipient.balance - recipientBefore, FLAT);
        assertEq(t.balanceOf(address(factory)), 0);
        assertEq(address(factory).balance, 0);

        uint64 at = v.unlockAt();
        vm.warp(block.timestamp + elapsed);
        vm.prank(alice);
        if (elapsed < duration) {
            vm.expectRevert(abi.encodeWithSelector(LockVault.StillLocked.selector, at));
            v.withdraw(bob);
            assertEq(t.balanceOf(address(v)), amount);
            assertEq(t.balanceOf(bob), 0);
        } else {
            v.withdraw(bob);
            assertEq(t.balanceOf(bob), amount); // exactly what went in comes out
            assertEq(t.balanceOf(address(v)), 0);
        }
    }

    function testFuzz_lockToken_unlockTimeBounds(uint256 seed) public {
        uint256 nowTs = block.timestamp;
        // A range that straddles both edges: zero and the past below, and a little beyond the ten-year limit above.
        uint64 unlockAt = uint64(bound(seed, 0, nowTs + MAX_DURATION + 1_000));
        bool valid = unlockAt > nowTs && unlockAt <= nowTs + MAX_DURATION;
        vm.prank(alice);
        if (valid) {
            address vault = factory.lockToken{value: FLAT}(token, 1 ether, unlockAt, alice);
            assertEq(LockVault(vault).unlockAt(), unlockAt);
        } else {
            vm.expectRevert(LockVault.BadUnlockTime.selector);
            factory.lockToken{value: FLAT}(token, 1 ether, unlockAt, alice);
            assertEq(factory.vaultsOfLength(alice), 0);
        }
    }

    /// For any (amount, unlock time, clock): a caller who is not the owner never moves value, and the owner never
    /// receives principal before the unlock time.
    function testFuzz_nonOwnerNeverReceivesValue_ownerNeverBeforeUnlock(
        uint256 amount,
        uint64 duration,
        uint64 skip,
        address caller,
        address to
    ) public {
        vm.assume(caller != alice && caller != address(0) && to != address(0));
        amount = bound(amount, 1, START_BALANCE);
        duration = uint64(bound(duration, 1, MAX_DURATION));
        LockVault v = _lock(alice, token, amount, duration, alice);
        uint64 at = v.unlockAt();
        vm.warp(block.timestamp + bound(skip, 0, 4000 days)); // before or after the unlock time
        uint256 vaultBefore = token.balanceOf(address(v));
        uint256 callerBefore = token.balanceOf(caller);
        uint256 toBefore = token.balanceOf(to);
        uint256 aliceBefore = token.balanceOf(alice);

        vm.startPrank(caller);
        vm.expectRevert(LockVault.NotOwner.selector);
        v.withdraw(to);
        vm.expectRevert(LockVault.NotOwner.selector);
        v.extend(at + 1);
        vm.expectRevert(LockVault.NotOwner.selector);
        v.transferOwnership(caller);
        vm.expectRevert(LockVault.NotPendingOwner.selector);
        v.acceptOwnership();
        vm.stopPrank();

        assertEq(token.balanceOf(address(v)), vaultBefore);
        assertEq(token.balanceOf(caller), callerBefore);
        assertEq(token.balanceOf(to), toBefore);
        assertEq(v.owner(), alice);

        // The owner, too, gets nothing before the unlock time.
        uint256 nowTs = block.timestamp;
        if (nowTs < at) {
            vm.prank(alice);
            vm.expectRevert(abi.encodeWithSelector(LockVault.StillLocked.selector, at));
            v.withdraw(alice);
            assertEq(token.balanceOf(alice), aliceBefore);
            assertEq(token.balanceOf(address(v)), vaultBefore);
        }
    }

    /// Any sequence of extensions, with time passing between them, never brings the unlock time forward.
    function testFuzz_ownerKeyCannotShortenALock(uint256[6] memory times, uint256[6] memory gaps) public {
        LockVault v = _lock(alice, token, 1 ether, 30 days, alice);
        for (uint256 i; i < times.length; ++i) {
            vm.warp(block.timestamp + bound(gaps[i], 0, 200 days));
            uint64 before = v.unlockAt();
            uint64 candidate = uint64(bound(times[i], 0, block.timestamp + 4000 days));
            vm.prank(alice);
            try v.extend(candidate) {
                assertGt(candidate, before);
                assertGt(candidate, block.timestamp);
            } catch {}
            assertGe(v.unlockAt(), before);
        }
    }
}
