// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {FeeController} from "../src/FeeController.sol";

contract FeeControllerTest is Test {
    FeeController internal fees;
    address internal owner = makeAddr("owner");
    address payable internal recipient = payable(makeAddr("recipient"));
    bytes32 internal constant KEY = keccak256("MINT_FLAT");

    function setUp() public {
        fees = new FeeController(owner, recipient);
        vm.prank(owner);
        fees.addKey(KEY, 15 ether, 50 ether);
    }

    function test_constructor_rejectsZeroRecipient() public {
        vm.expectRevert(FeeController.ZeroRecipient.selector);
        new FeeController(owner, payable(address(0)));
    }

    function test_addKey_setsValueAndCap() public view {
        assertEq(fees.feeOf(KEY), 15 ether);
        assertEq(fees.capOf(KEY), 50 ether);
    }

    function test_addKey_rejectsDuplicateAboveCapAndStrangers() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(FeeController.KeyExists.selector, KEY));
        fees.addKey(KEY, 1, 2);
        vm.expectRevert(abi.encodeWithSelector(FeeController.AboveCap.selector, 3, 2));
        fees.addKey(keccak256("X"), 3, 2);
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        fees.addKey(keccak256("Y"), 1, 2);
    }

    function test_feeOf_revertsForUnknownKey() public {
        vm.expectRevert(abi.encodeWithSelector(FeeController.UnknownKey.selector, keccak256("NOPE")));
        fees.feeOf(keccak256("NOPE"));
    }

    function test_decrease_appliesImmediately_andCancelsPending() public {
        vm.startPrank(owner);
        fees.setFee(KEY, 40 ether); // schedules
        fees.setFee(KEY, 10 ether); // decrease
        vm.stopPrank();
        assertEq(fees.feeOf(KEY), 10 ether);
        vm.expectRevert(abi.encodeWithSelector(FeeController.NothingPending.selector, KEY));
        fees.applyPending(KEY);
    }

    function test_increase_waitsForDelay() public {
        vm.prank(owner);
        fees.setFee(KEY, 40 ether);
        assertEq(fees.feeOf(KEY), 15 ether);
        uint64 at = uint64(block.timestamp + 48 hours);
        vm.expectRevert(abi.encodeWithSelector(FeeController.TooEarly.selector, at));
        fees.applyPending(KEY);
        vm.warp(at);
        fees.applyPending(KEY); // anyone may apply once the delay has passed
        assertEq(fees.feeOf(KEY), 40 ether);
    }

    function test_setFee_neverExceedsCap() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(FeeController.AboveCap.selector, 51 ether, 50 ether));
        fees.setFee(KEY, 51 ether);
    }

    function testFuzz_feeNeverExceedsCap(uint256 value, uint32 wait) public {
        vm.prank(owner);
        try fees.setFee(KEY, value) {} catch {}
        vm.warp(block.timestamp + wait);
        try fees.applyPending(KEY) {} catch {}
        assertLe(fees.feeOf(KEY), fees.capOf(KEY));
    }

    function test_setRecipient_ownerOnly_nonZero() public {
        vm.prank(owner);
        vm.expectRevert(FeeController.ZeroRecipient.selector);
        fees.setRecipient(payable(address(0)));
        vm.prank(owner);
        fees.setRecipient(payable(address(7)));
        assertEq(fees.recipient(), address(7));
    }

    function test_setFee_revertsForNonOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        fees.setFee(KEY, 10 ether);
    }

    function test_setRecipient_revertsForNonOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        fees.setRecipient(payable(address(7)));
    }

    function test_reschedulingWhilePending_replacesValueAndRestartsClock() public {
        vm.startPrank(owner);
        fees.setFee(KEY, 30 ether); // schedules for now + 48h
        (uint256 firstValue, uint64 firstAt) = fees.pendingOf(KEY);
        assertEq(firstValue, 30 ether);
        assertEq(firstAt, uint64(block.timestamp + 48 hours));

        vm.warp(block.timestamp + 24 hours); // still pending, halfway through the delay
        fees.setFee(KEY, 45 ether); // a second increase replaces the pending value and restarts the clock
        vm.stopPrank();

        (uint256 secondValue, uint64 secondAt) = fees.pendingOf(KEY);
        assertEq(secondValue, 45 ether);
        assertEq(secondAt, uint64(block.timestamp + 48 hours));
        assertTrue(secondAt > firstAt); // clock was restarted, not kept from the first schedule

        // the first increase can no longer be applied at its old effective time
        vm.warp(firstAt);
        vm.expectRevert(abi.encodeWithSelector(FeeController.TooEarly.selector, secondAt));
        fees.applyPending(KEY);

        // once the restarted delay elapses, the replaced (second) value is what applies
        vm.warp(secondAt);
        fees.applyPending(KEY);
        assertEq(fees.feeOf(KEY), 45 ether);
    }

    function test_ownership_isTwoStep() public {
        address next = makeAddr("next");
        vm.prank(owner);
        fees.transferOwnership(next);
        assertEq(fees.owner(), owner);
        vm.prank(next);
        fees.acceptOwnership();
        assertEq(fees.owner(), next);
    }
}
