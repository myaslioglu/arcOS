// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {FeeController} from "../../src/FeeController.sol";
import {LockVault} from "../../src/vault/LockVault.sol";
import {VaultFactory} from "../../src/vault/VaultFactory.sol";
import {VaultTestBase} from "./VaultTestBase.sol";
import {
    MockBlockableToken,
    MockRecipientChanger,
    MockRevertingReceiver,
    MockToken,
    MockV2Pair
} from "./mocks/VaultMocks.sol";

/// Fees: the flat fee in native value, the percentage on v2 LP tokens (rounding pinned), fee changes that never
/// reach an existing lock, and what happens when a fee transfer fails, as it does for a blocklisted address on Arc.
contract VaultFeesTest is VaultTestBase {
    using SafeCast for uint256;

    /// OpenZeppelin's ERC-7201 slot for `Initializable`'s state (the only vault state outside slots 0 to 2).
    bytes32 internal constant INITIALIZABLE_SLOT = 0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00;

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _lockPair(address user, uint256 amount, uint256 duration, address owner_) internal returns (LockVault) {
        return _lock(user, IERC20(address(pair)), amount, duration, owner_);
    }

    /// floor(amount * bps / 10_000), written so that it cannot overflow and shares nothing with the contract's
    /// arithmetic: split the amount into whole multiples of 10,000 and a remainder.
    function _floorBps(uint256 amount, uint256 bps) internal pure returns (uint256) {
        // Dividing first is exact here, not a loss of precision: amount = q * 10_000 + r, and r has its own term.
        // forge-lint: disable-next-line(divide-before-multiply)
        return (amount / 10_000) * bps + ((amount % 10_000) * bps) / 10_000;
    }

    /// A factory on its own controller whose LP fee is `bps`, and a fresh LP token with `amount` minted to `user`.
    function _privateLp(uint256 bps, uint256 amount, address user) internal returns (VaultFactory f, MockV2Pair p) {
        FeeController c = _newFeeController(FLAT, FLAT_CAP, bps, 10_000, SHARE_BPS, SHARE_BPS_CAP);
        f = new VaultFactory(factoryOwner, c);
        p = new MockV2Pair(address(token), address(0xdead), 0);
        p.mint(user, amount);
        vm.deal(user, user.balance + FLAT);
        vm.prank(user);
        p.approve(address(f), type(uint256).max);
    }

    /// Locks `amount` of a fresh LP token at `bps` and returns (fee taken, amount locked).
    function _privateLock(uint256 bps, uint256 amount) internal returns (uint256 fee, uint256 locked) {
        address user = makeAddr("fuzzUser");
        (VaultFactory f, MockV2Pair p) = _privateLp(bps, amount, user);
        uint64 at = (block.timestamp + 1 days).toUint64();
        vm.prank(user);
        address vault = f.lockToken{value: FLAT}(IERC20(address(p)), amount, at, user);
        return (p.balanceOf(feeRecipient), p.balanceOf(vault));
    }

    function _vaultStorage(address v) internal view returns (bytes32[6] memory s) {
        for (uint256 i; i < 5; ++i) {
            s[i] = vm.load(v, bytes32(i));
        }
        s[5] = vm.load(v, INITIALIZABLE_SLOT);
    }

    // ---------------------------------------------------------------------
    // The flat fee
    // ---------------------------------------------------------------------

    function test_flatFee_isPaidAsNativeValue_toTheRecipient() public {
        uint256 before = feeRecipient.balance;
        _lock(alice, token, 1 ether, 1 days, alice);
        _lockPair(alice, 1 ether, 1 days, alice);
        _lock(bob, token, 1 ether, 1 days, bob);
        assertEq(feeRecipient.balance, before + 3 * FLAT);
        assertEq(address(factory).balance, 0);
    }

    function test_flatFee_canBeZero_ifTheRecipientCanStillReceive() public {
        vm.prank(feeOwner);
        fees.setFee(KEY_FLAT, 0);
        uint256 before = feeRecipient.balance;
        uint64 at = (block.timestamp + 1 days).toUint64();
        vm.prank(alice);
        factory.lockToken(token, 1 ether, at, alice); // no value at all
        assertEq(feeRecipient.balance, before);
        assertEq(factory.vaultsOfLength(alice), 1);

        // The transfer is still made with zero value, so a recipient that reverts on receipt still blocks locking.
        MockRevertingReceiver blocked = new MockRevertingReceiver();
        vm.prank(feeOwner);
        fees.setRecipient(payable(address(blocked)));
        vm.prank(alice);
        vm.expectRevert(VaultFactory.FeeTransferFailed.selector);
        factory.lockToken(token, 1 ether, at, alice);
    }

    // ---------------------------------------------------------------------
    // The percentage fee on v2 LP tokens
    // ---------------------------------------------------------------------

    function test_lpFee_isChargedOnlyForV2Pairs() public {
        LockVault plain = _lock(alice, token, 10_000 ether, 30 days, alice);
        assertEq(token.balanceOf(feeRecipient), 0);
        assertEq(token.balanceOf(address(plain)), 10_000 ether);

        LockVault lp = _lockPair(alice, 10_000 ether, 30 days, alice);
        assertEq(pair.balanceOf(feeRecipient), 50 ether); // 0.50%
        assertEq(pair.balanceOf(address(lp)), 9_950 ether);
        assertEq(pair.balanceOf(address(factory)), 0);
    }

    function test_lpFee_isReportedInTheEvent_andTheLockIsRegisteredUnderThePair() public {
        Snap memory s = _snap(bob, address(pair));
        uint64 at = (block.timestamp + 30 days).toUint64();
        vm.expectEmit(true, true, false, true, address(factory));
        emit VaultFactory.TokenLocked(bob, address(pair), s.predicted, 9_950 ether, 50 ether, at);
        vm.prank(alice);
        address vault = factory.lockToken{value: FLAT}(IERC20(address(pair)), 10_000 ether, at, bob);

        assertEq(factory.vaultsForToken(address(pair))[0], vault);
        assertEq(factory.vaultsForTokenLength(pair.token0()), 0); // keyed by the locked token, not by its currencies
    }

    /// The rounding direction, pinned: the fee is floor(amount * bps / 10_000), so it rounds DOWN, in the locker's
    /// favour; the vault receives the remainder, and the platform never takes more than the stated share.
    function test_lpFee_pinnedVectors() public {
        uint256[10] memory amounts = [uint256(1), 3, 199, 200, 201, 399, 400, 10_000, 19_999, 1e18];
        uint256[10] memory fees_ = [uint256(0), 0, 0, 1, 1, 1, 2, 50, 99, 5e15];
        for (uint256 i; i < amounts.length; ++i) {
            uint256 recipientBefore = pair.balanceOf(feeRecipient);
            LockVault v = _lockPair(alice, amounts[i], 30 days, alice);
            assertEq(pair.balanceOf(feeRecipient) - recipientBefore, fees_[i], "fee");
            assertEq(pair.balanceOf(address(v)), amounts[i] - fees_[i], "locked");
        }
    }

    function test_lpFee_roundsDown_inTheLockersFavour() public {
        uint256[12] memory amounts = [uint256(1), 2, 199, 200, 201, 399, 400, 401, 9_999, 10_001, 19_999, 20_001];
        for (uint256 i; i < amounts.length; ++i) {
            uint256 recipientBefore = pair.balanceOf(feeRecipient);
            LockVault v = _lockPair(alice, amounts[i], 30 days, alice);
            uint256 fee = pair.balanceOf(feeRecipient) - recipientBefore;
            // fee * 10_000 <= amount * 50 < (fee + 1) * 10_000
            assertLe(fee * 10_000, amounts[i] * 50, "fee is never above the share");
            assertGt((fee + 1) * 10_000, amounts[i] * 50, "fee is the largest whole number not above the share");
            assertEq(fee + pair.balanceOf(address(v)), amounts[i], "the fee and the lock add up to the amount");
        }
    }

    function testFuzz_lpFee_isFlooredExactly(uint256 amount, uint256 bpsSeed) public {
        uint256 bps = bound(bpsSeed, 0, 9_999);
        amount = bound(amount, 1, type(uint256).max);
        (uint256 fee, uint256 locked) = _privateLock(bps, amount);
        assertEq(fee, _floorBps(amount, bps), "fee is floor(amount * bps / 10_000)");
        assertEq(fee + locked, amount, "nothing is created or lost");
    }

    /// Adding one LP token to a lock can raise the fee by at most one, and never lowers it.
    function testFuzz_lpFee_isMonotoneAndStepsByAtMostOne(uint256 amount, uint256 bpsSeed) public {
        uint256 bps = bound(bpsSeed, 0, 9_999);
        amount = bound(amount, 1, type(uint256).max - 1);
        (uint256 smaller,) = _privateLock(bps, amount);
        (uint256 larger,) = _privateLock(bps, amount + 1);
        assertGe(larger, smaller);
        assertLe(larger - smaller, 1);
    }

    function test_lpFee_fullRangeAmounts_doNotOverflow() public {
        uint256 amount = type(uint256).max;
        (uint256 fee, uint256 locked) = _privateLock(100, amount);
        assertEq(fee, _floorBps(amount, 100));
        assertEq(fee + locked, amount);
    }

    function test_lpFee_bpsAboveTenThousand_reverts_butTeamTokensAreUnaffected() public {
        FeeController c = _newFeeController(FLAT, FLAT_CAP, 10_001, type(uint256).max, SHARE_BPS, SHARE_BPS_CAP);
        VaultFactory f = new VaultFactory(factoryOwner, c);
        vm.startPrank(alice);
        pair.approve(address(f), type(uint256).max);
        token.approve(address(f), type(uint256).max);
        uint64 at = (block.timestamp + 30 days).toUint64();

        vm.expectRevert(abi.encodeWithSelector(VaultFactory.FeeOutOfRange.selector, KEY_LP, 10_001));
        f.lockToken{value: FLAT}(IERC20(address(pair)), 10_000 ether, at, alice);

        // The percentage is never read for a token that is not an LP token.
        f.lockToken{value: FLAT}(token, 10_000 ether, at, alice);
        vm.stopPrank();
        assertEq(f.vaultsOfLength(alice), 1);
    }

    // ---------------------------------------------------------------------
    // Fee changes never reach an existing lock
    // ---------------------------------------------------------------------

    function test_laterFeeChange_neverTouchesAnExistingLock() public {
        LockVault v = _lockPair(alice, 10_000 ether, 30 days, alice); // pays 50 in LP, locks 9,950
        bytes32[6] memory stateBefore = _vaultStorage(address(v));
        assertEq(address(uint160(uint256(stateBefore[0]))), alice, "the read is real: slot 0 is the owner");
        uint256 lockedBefore = pair.balanceOf(address(v));

        // Every fee goes up (scheduled, then applied after the delay) ...
        vm.startPrank(feeOwner);
        fees.setFee(KEY_FLAT, 100 ether);
        fees.setFee(KEY_LP, 100);
        fees.setFee(KEY_SHARE, 500);
        vm.stopPrank();
        vm.warp(block.timestamp + 48 hours);
        fees.applyPending(KEY_FLAT);
        fees.applyPending(KEY_LP);
        fees.applyPending(KEY_SHARE);
        assertEq(fees.feeOf(KEY_FLAT), 100 ether);
        // ... and one goes to zero at once.
        vm.prank(feeOwner);
        fees.setFee(KEY_LP, 0);

        bytes32[6] memory stateAfter = _vaultStorage(address(v));
        for (uint256 i; i < stateBefore.length; ++i) {
            assertEq(stateAfter[i], stateBefore[i], "the vault's state moved with a fee");
        }
        assertEq(pair.balanceOf(address(v)), lockedBefore);

        // The lock still releases everything it holds, and no fee is taken at withdrawal.
        vm.warp(v.unlockAt());
        uint256 recipientPair = pair.balanceOf(feeRecipient);
        uint256 recipientNative = feeRecipient.balance;
        uint256 bobBefore = pair.balanceOf(bob);
        vm.prank(alice);
        v.withdraw(bob);
        assertEq(pair.balanceOf(bob) - bobBefore, lockedBefore);
        assertEq(pair.balanceOf(address(v)), 0);
        assertEq(pair.balanceOf(feeRecipient), recipientPair);
        assertEq(feeRecipient.balance, recipientNative);
    }

    function test_feeIncrease_isNotSeenUntilApplied() public {
        vm.prank(feeOwner);
        fees.setFee(KEY_FLAT, 100 ether); // scheduled: takes effect after 48 hours

        _lock(alice, token, 1 ether, 30 days, alice); // still costs 30
        uint64 at = (block.timestamp + 30 days).toUint64();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(VaultFactory.WrongFee.selector, FLAT, 100 ether));
        factory.lockToken{value: 100 ether}(token, 1 ether, at, alice);

        vm.warp(block.timestamp + 48 hours);
        fees.applyPending(KEY_FLAT);
        at = (block.timestamp + 30 days).toUint64();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(VaultFactory.WrongFee.selector, 100 ether, FLAT));
        factory.lockToken{value: FLAT}(token, 1 ether, at, alice);
        vm.prank(alice);
        factory.lockToken{value: 100 ether}(token, 1 ether, at, alice);
        assertEq(factory.vaultsOfLength(alice), 2);
    }

    function test_feeDecrease_appliesToTheNextLockAtOnce() public {
        vm.prank(feeOwner);
        fees.setFee(KEY_FLAT, 10 ether);
        uint256 before = feeRecipient.balance;
        uint64 at = (block.timestamp + 30 days).toUint64();
        vm.prank(alice);
        factory.lockToken{value: 10 ether}(token, 1 ether, at, alice);
        assertEq(feeRecipient.balance, before + 10 ether);
    }

    /// One call pays one recipient: the address read when the call began, even if the fee recipient changes the
    /// recipient while it is being paid.
    function test_oneRecipientPerCall() public {
        address payable elsewhere = payable(makeAddr("elsewhere"));
        MockRecipientChanger changer = new MockRecipientChanger(fees, elsewhere);
        vm.startPrank(feeOwner);
        fees.setRecipient(payable(address(changer)));
        fees.transferOwnership(address(changer));
        vm.stopPrank();
        changer.acceptOwnership();

        _lockPair(alice, 10_000 ether, 30 days, alice); // flat fee first, then the LP fee

        assertEq(fees.recipient(), elsewhere, "the recipient did change during the call");
        assertEq(address(changer).balance, FLAT, "the flat fee went to the first recipient");
        assertEq(pair.balanceOf(address(changer)), 50 ether, "so did the LP fee");
        assertEq(pair.balanceOf(elsewhere), 0);
    }

    // ---------------------------------------------------------------------
    // Blocklisted addresses: Arc reverts value transfers to or from one, and a token can do the same. A fee transfer
    // that fails reverts the whole lock and leaves nothing behind.
    // ---------------------------------------------------------------------

    function test_blocklisted_flatFeeRecipient_revertsTheWholeLock() public {
        MockRevertingReceiver blocked = new MockRevertingReceiver();
        vm.prank(feeOwner);
        fees.setRecipient(payable(address(blocked)));
        Snap memory s = _snap(alice, address(token));
        uint256 aliceTokens = token.balanceOf(alice);
        uint256 aliceNative = alice.balance;
        uint64 at = (block.timestamp + 30 days).toUint64();

        vm.prank(alice);
        vm.expectRevert(VaultFactory.FeeTransferFailed.selector);
        factory.lockToken{value: FLAT}(token, 1 ether, at, alice);

        _assertNothingLeftBehind(s, alice, address(token));
        assertEq(token.balanceOf(alice), aliceTokens);
        assertEq(alice.balance, aliceNative);
        assertEq(token.balanceOf(address(factory)), 0);

        // The fee owner can always point the recipient at an address that works, and the retry lands where the
        // failed attempt would have: nothing was consumed.
        vm.prank(feeOwner);
        fees.setRecipient(feeRecipient);
        LockVault v = _lock(alice, token, 1 ether, 30 days, alice);
        assertEq(address(v), s.predicted);
    }

    function test_blocklisted_lpFeeRecipient_revertsTheWholeLock() public {
        pair.setBlocked(feeRecipient, true); // the LP token refuses transfers to the fee recipient
        Snap memory s = _snap(alice, address(pair));
        uint256 aliceLp = pair.balanceOf(alice);
        uint256 aliceNative = alice.balance;
        uint256 recipientNative = feeRecipient.balance;
        uint256 allowance = pair.allowance(alice, address(factory));
        uint64 at = (block.timestamp + 30 days).toUint64();

        vm.prank(alice);
        vm.expectRevert("blocked");
        factory.lockToken{value: FLAT}(IERC20(address(pair)), 10_000 ether, at, alice);

        _assertNothingLeftBehind(s, alice, address(pair));
        assertEq(pair.balanceOf(alice), aliceLp);
        assertEq(alice.balance, aliceNative);
        assertEq(feeRecipient.balance, recipientNative, "the flat fee, already paid inside the call, was rolled back");
        assertEq(pair.allowance(alice, address(factory)), allowance);
    }

    function test_blocklisted_locker_revertsTheWholeLock() public {
        MockBlockableToken blk = new MockBlockableToken();
        blk.mint(alice, 100 ether);
        vm.startPrank(alice);
        blk.approve(address(factory), type(uint256).max);
        vm.stopPrank();
        blk.setBlocked(alice, true);
        Snap memory s = _snap(alice, address(blk));
        uint256 recipientNative = feeRecipient.balance;
        uint64 at = (block.timestamp + 30 days).toUint64();

        vm.prank(alice);
        vm.expectRevert("blocked");
        factory.lockToken{value: FLAT}(IERC20(address(blk)), 10 ether, at, alice);

        _assertNothingLeftBehind(s, alice, address(blk));
        assertEq(blk.balanceOf(alice), 100 ether);
        assertEq(feeRecipient.balance, recipientNative);
    }
}
