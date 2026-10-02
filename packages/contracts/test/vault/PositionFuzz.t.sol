// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {PositionVault} from "../../src/vault/PositionVault.sol";
import {PositionTestBase} from "./PositionTestBase.sol";
import {MockToken} from "./mocks/VaultMocks.sol";

/// Property tests for PositionVault over random fees, shares, times and callers, with the mock managers.
contract PositionFuzzTest is PositionTestBase {
    using SafeCast for uint256;

    /// A vault made directly from a clone, so the share can be any value up to 10,000 bps. `pool` 0 is v3 A/B, 1 is
    /// v4 A/B, 2 is v4 native/A.
    function _vault(uint8 pool, uint16 share, uint64 unlockAt) internal returns (PositionVault v, uint256 id) {
        v = PositionVault(payable(Clones.clone(factory.positionVaultImpl())));
        if (pool == 0) {
            id = v3.mint(address(this), address(tokenA), address(tokenB), LIQUIDITY);
            v.initialize(alice, address(v3), id, unlockAt, PositionVault.Kind.V3, share, feeRecipient);
            v3.safeTransferFrom(address(this), address(v), id);
        } else {
            address c0 = pool == 2 ? NATIVE : address(tokenA);
            address c1 = pool == 2 ? address(tokenA) : address(tokenB);
            id = v4.mint(address(this), c0, c1, LIQUIDITY);
            v.initialize(alice, address(v4), id, unlockAt, PositionVault.Kind.V4, share, feeRecipient);
            v4.safeTransferFrom(address(this), address(v), id);
        }
    }

    function _balance(address currency, address who) internal view returns (uint256) {
        return currency == NATIVE ? who.balance : MockToken(currency).balanceOf(who);
    }

    /// [owner's currency0, recipient's currency0, owner's currency1, recipient's currency1]
    function _balances(address c0, address c1) internal view returns (uint256[4] memory b) {
        b = [_balance(c0, alice), _balance(c0, feeRecipient), _balance(c1, alice), _balance(c1, feeRecipient)];
    }

    /// For any fees and any share, the platform gets exactly floor(amount * share / 10,000) of each currency, the owner
    /// the rest, the vault keeps nothing and the principal is untouched.
    function testFuzz_collect_splitsExactly(uint256 poolSeed, uint16 shareSeed, uint128 a0, uint128 a1) public {
        uint8 pool = (poolSeed % 3).toUint8();
        uint16 share = uint16(bound(shareSeed, 0, 10_000));
        a0 = uint128(bound(a0, 0, 1e30));
        a1 = uint128(bound(a1, 0, 1e30));
        (PositionVault v, uint256 id) = _vault(pool, share, uint64(block.timestamp + 1 days));
        (address c0, address c1) = v.currencies();
        if (pool == 0) v3.accrue(id, a0, a1);
        else _accrueV4(id, c0, a0, a1);
        uint256[4] memory before = _balances(c0, c1);

        vm.prank(alice);
        v.collect();

        uint256[4] memory afterwards = _balances(c0, c1);
        uint256 p0 = (uint256(a0) * share) / 10_000;
        uint256 p1 = (uint256(a1) * share) / 10_000;
        assertEq(afterwards[0] - before[0], a0 - p0, "owner, currency0");
        assertEq(afterwards[1] - before[1], p0, "platform, currency0");
        assertEq(afterwards[2] - before[2], a1 - p1, "owner, currency1");
        assertEq(afterwards[3] - before[3], p1, "platform, currency1");
        assertEq(_balance(c0, address(v)) + _balance(c1, address(v)), 0, "the vault kept something");
        assertEq(pool == 0 ? v3.liquidityOf(id) : v4.getPositionLiquidity(id), LIQUIDITY, "principal moved");
    }

    /// For any caller, lock length and time: a non-owner can neither collect nor withdraw and receives nothing, and the
    /// owner never gets the NFT before the unlock time.
    function testFuzz_nonOwnerNeverReceivesValue_ownerNeverGetsThePositionEarly(
        uint256 poolSeed,
        address caller,
        uint256 durationSeed,
        uint256 warpSeed
    ) public {
        vm.assume(caller != alice && caller != address(0));
        uint8 pool = (poolSeed % 3).toUint8();
        uint64 at = (block.timestamp + bound(durationSeed, 1, 3650 days)).toUint64();
        (PositionVault v, uint256 id) = _vault(pool, 200, at);
        if (pool == 0) v3.accrue(id, 1 ether, 1 ether);
        else _accrueV4(id, pool == 2 ? NATIVE : address(tokenA), 1 ether, 1 ether);
        vm.warp(bound(warpSeed, block.timestamp, uint256(at) + 400 days));
        address manager = pool == 0 ? address(v3) : address(v4);
        uint256 callerNative = caller.balance;
        uint256 callerA = tokenA.balanceOf(caller);
        uint256 callerB = tokenB.balanceOf(caller);

        vm.startPrank(caller);
        vm.expectRevert(PositionVault.NotOwner.selector);
        v.collect();
        vm.expectRevert(PositionVault.NotOwner.selector);
        v.withdraw(caller);
        vm.stopPrank();
        assertEq(caller.balance, callerNative);
        assertEq(tokenA.balanceOf(caller), callerA);
        assertEq(tokenB.balanceOf(caller), callerB);
        assertEq(PositionVault(payable(v)).owner(), alice);
        assertEq(_ownerOf(manager, id), address(v));

        uint256 nowTs = block.timestamp;
        vm.prank(alice);
        if (nowTs < at) {
            vm.expectRevert(abi.encodeWithSelector(PositionVault.StillLocked.selector, at));
            v.withdraw(alice);
            assertEq(_ownerOf(manager, id), address(v));
        } else {
            v.withdraw(alice);
            assertEq(_ownerOf(manager, id), alice);
        }
    }

    function _ownerOf(address manager, uint256 id) internal view returns (address) {
        return manager == address(v3) ? v3.ownerOf(id) : v4.ownerOf(id);
    }

    /// For any candidate time, extend succeeds exactly when the time is later, in the future and within
    /// MAX_DURATION of now, and the unlock time never goes down.
    function testFuzz_extend_onlyLengthens(uint256 durationSeed, uint256 warpSeed, uint64 candidate) public {
        uint64 at = (block.timestamp + bound(durationSeed, 1, 3650 days)).toUint64();
        (PositionVault v,) = _vault(0, 200, at);
        vm.warp(bound(warpSeed, block.timestamp, uint256(at) + 400 days));
        uint256 nowTs = block.timestamp;
        bool ok = candidate > at && candidate > nowTs && candidate <= nowTs + 3650 days;
        vm.prank(alice);
        if (!ok) vm.expectRevert(PositionVault.BadUnlockTime.selector);
        v.extend(candidate);
        assertEq(v.unlockAt(), ok ? candidate : at);
    }
}
