// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ArcVesting} from "../../src/vesting/ArcVesting.sol";
import {VestingFactory} from "../../src/vesting/VestingFactory.sol";
import {VestingTestBase} from "./VestingTestBase.sol";

/// Fuzzed properties of the schedule. The reference curve is written here from the definition, with `Math.mulDiv`
/// rather than OpenZeppelin's `total * elapsed / duration`, so the two agree only if both are right.
///
/// Rounding: what has vested rounds DOWN. The beneficiary is never ahead of the schedule, by less than one unit of
/// the token, and the remainder vests at the end. `testFuzz_curveMatchesTheReference` pins the direction exactly.
contract VestingFuzzTest is VestingTestBase {
    struct Schedule {
        uint256 amount;
        uint64 start;
        uint64 duration;
        uint64 cliff;
    }

    function _bounded(uint256 amount, uint256 startSeed, uint256 durationSeed, uint256 cliffSeed)
        internal
        view
        returns (Schedule memory s)
    {
        s.amount = bound(amount, 1, factory.MAX_AMOUNT());
        s.duration = uint64(bound(durationSeed, 1, MAX_DURATION));
        s.cliff = uint64(bound(cliffSeed, 0, s.duration));
        // anywhere from 10 years back to 10 years out
        s.start = uint64(bound(startSeed, block.timestamp - MAX_DURATION, block.timestamp + MAX_DURATION));
    }

    function _make(Schedule memory s) internal returns (ArcVesting) {
        token.mint(alice, s.amount);
        return _create(alice, token, bob, s.amount, s.start, s.duration, s.cliff);
    }

    /// The schedule, from its definition.
    function _reference(Schedule memory s, uint256 t) internal pure returns (uint256) {
        if (t < uint256(s.start) + s.cliff) return 0;
        if (t >= uint256(s.start) + s.duration) return s.amount;
        return Math.mulDiv(s.amount, t - s.start, s.duration); // rounds down
    }

    function testFuzz_curveMatchesTheReference(
        uint256 amount,
        uint256 startSeed,
        uint256 durationSeed,
        uint256 cliffSeed,
        uint256 tSeed
    ) public {
        Schedule memory s = _bounded(amount, startSeed, durationSeed, cliffSeed);
        ArcVesting w = _make(s);
        uint64 t = uint64(bound(tSeed, 0, uint256(s.start) + s.duration + 30 days));
        uint256 vested = w.vestedAmount(address(token), t);
        assertEq(vested, _reference(s, t), "vested differs from the reference");
        assertLe(vested, s.amount, "vested more than was funded");
        if (t < w.cliff()) assertEq(vested, 0, "vested before the cliff");
        if (t >= w.end()) assertEq(vested, s.amount, "not everything vested at the end");
        if (t >= w.cliff() && t < w.end()) {
            // Round down, by less than one unit: vested * duration <= amount * elapsed < (vested + 1) * duration.
            uint256 elapsed = t - s.start;
            (uint256 hi, uint256 lo) = Math.mul512(s.amount, elapsed);
            assertEq(hi, 0);
            assertLe(vested * s.duration, lo, "rounded up");
            assertGt((vested + 1) * s.duration, lo, "rounded down by a unit or more");
        }
    }

    function testFuzz_vestedIsMonotonicInTime(
        uint256 amount,
        uint256 startSeed,
        uint256 durationSeed,
        uint256 cliffSeed,
        uint256 t1Seed,
        uint256 t2Seed
    ) public {
        Schedule memory s = _bounded(amount, startSeed, durationSeed, cliffSeed);
        ArcVesting w = _make(s);
        uint256 horizon = uint256(s.start) + s.duration + 1 days;
        uint64 t1 = uint64(bound(t1Seed, 0, horizon));
        uint64 t2 = uint64(bound(t2Seed, t1, horizon));
        assertLe(w.vestedAmount(address(token), t1), w.vestedAmount(address(token), t2));
    }

    /// Releases at random moments: after each, `released <= vested <= amount`, the beneficiary holds exactly what was
    /// released, and at the end everything has been released and the wallet is empty.
    function testFuzz_releasesFollowTheSchedule(
        uint256 amount,
        uint256 startSeed,
        uint256 durationSeed,
        uint256 cliffSeed,
        uint256[4] memory steps
    ) public {
        Schedule memory s = _bounded(amount, startSeed, durationSeed, cliffSeed);
        ArcVesting w = _make(s);
        uint256 bobBefore = token.balanceOf(bob);
        uint256 horizon = Math.max(block.timestamp, uint256(s.start) + s.duration + 1 days); // may start long ago
        for (uint256 i; i < steps.length; ++i) {
            vm.warp(bound(steps[i], block.timestamp, horizon));
            w.release(address(token));
            uint256 released = w.released(address(token));
            uint256 vested = w.vestedAmount(address(token), uint64(block.timestamp));
            assertEq(released, _reference(s, block.timestamp), "released differs from the reference");
            assertLe(released, vested);
            assertLe(vested, s.amount);
            assertEq(token.balanceOf(bob) - bobBefore, released, "the beneficiary did not get what was released");
            assertEq(token.balanceOf(address(w)) + released, s.amount, "tokens appeared or vanished");
            if (block.timestamp < w.cliff()) assertEq(released, 0, "released before the cliff");
        }
        vm.warp(Math.max(block.timestamp, w.end()));
        w.release(address(token));
        assertEq(w.released(address(token)), s.amount);
        assertEq(token.balanceOf(address(w)), 0);
        assertEq(token.balanceOf(address(factory)), 0);
    }

    /// Any arguments: the call succeeds exactly when the schedule is valid, and a failure leaves nothing behind.
    function testFuzz_scheduleValidation(
        uint256 amount,
        uint64 start,
        uint64 duration,
        uint64 cliff,
        bool zeroBeneficiary
    ) public {
        amount = bound(amount, 0, factory.MAX_AMOUNT() * 2);
        address beneficiary = zeroBeneficiary ? address(0) : bob;
        token.mint(alice, amount);
        bool valid = amount != 0 && amount <= factory.MAX_AMOUNT() && duration != 0 && duration <= MAX_DURATION
            && cliff <= duration && start <= block.timestamp + MAX_DURATION && beneficiary != address(0);
        uint256 nonce = vm.getNonce(address(factory));
        uint256 aliceBefore = token.balanceOf(alice);
        vm.prank(alice);
        try factory.createVesting{value: VEST_FEE}(token, beneficiary, amount, start, duration, cliff) returns (
            address w
        ) {
            assertTrue(valid, "an invalid schedule was accepted");
            assertEq(token.balanceOf(w), amount);
            assertEq(ArcVesting(payable(w)).cliff(), uint256(start) + cliff);
        } catch {
            assertFalse(valid, "a valid schedule was refused");
            assertEq(vm.getNonce(address(factory)), nonce);
            assertEq(token.balanceOf(alice), aliceBefore);
        }
    }

    function testFuzz_onlyTheExactFeeIsAccepted(uint256 sent) public {
        sent = bound(sent, 0, 1_000 ether);
        uint256 recipientBefore = feeRecipient.balance;
        vm.prank(alice);
        try factory.createVesting{value: sent}(token, bob, 1 ether, uint64(block.timestamp), 1 days, 0) {
            assertEq(sent, VEST_FEE);
            assertEq(feeRecipient.balance - recipientBefore, VEST_FEE);
        } catch (bytes memory reason) {
            assertTrue(sent != VEST_FEE);
            assertEq(reason, abi.encodeWithSelector(VestingFactory.WrongFee.selector, VEST_FEE, sent));
        }
        assertEq(address(factory).balance, 0);
    }

    function testFuzz_slicesMatchTheWholeList(uint8 n, uint256 start, uint256 count) public {
        n = uint8(bound(n, 0, 12));
        for (uint256 i; i < n; ++i) {
            _create(alice, token, bob, 1 ether, uint64(block.timestamp), 1 days, 0);
        }
        address[] memory all = factory.vestingsOf(bob);
        address[] memory got = factory.vestingsOfSlice(bob, start, count);
        uint256 from = start >= all.length ? all.length : start;
        uint256 expectedLength = Math.min(count, all.length - from);
        assertEq(got.length, expectedLength);
        for (uint256 i; i < got.length; ++i) {
            assertEq(got[i], all[from + i]);
        }
        assertEq(factory.vestingsOfLength(bob), n);
        address[] memory byToken = factory.vestingsForTokenSlice(address(token), start, count);
        assertEq(byToken.length, expectedLength);
    }
}
