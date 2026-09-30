// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {FeeController} from "../src/FeeController.sol";
import {IFeeController} from "../src/interfaces/IFeeController.sol";
import {ProPass} from "../src/ProPass.sol";
import {MockRevertingReceiver} from "./vault/mocks/VaultMocks.sol";

contract ProPassTest is Test {
    using SafeCast for uint256;

    uint256 internal constant PRICE = 9 ether; // 9 USDC a month, as native value (18 decimals)
    uint256 internal constant PRICE_CAP = 29 ether;
    uint256 internal constant MONTH = 30 days;
    bytes32 internal constant KEY = keccak256("PRO_MONTHLY");

    address internal feeOwner = makeAddr("feeOwner");
    address payable internal feeRecipient = payable(makeAddr("feeRecipient"));
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    FeeController internal fees;
    ProPass internal pass;

    event Subscribed(address indexed account, address indexed payer, uint256 months, uint64 paidUntil);

    function setUp() public {
        vm.warp(1_800_000_000);
        fees = new FeeController(feeOwner, feeRecipient);
        vm.prank(feeOwner);
        fees.addKey(KEY, PRICE, PRICE_CAP);
        pass = new ProPass(fees);
        vm.deal(alice, 10_000 ether);
        vm.deal(bob, 10_000 ether);
    }

    function _subscribe(address payer, address account, uint256 months) internal {
        uint256 fee = months * fees.feeOf(KEY);
        vm.prank(payer);
        pass.subscribe{value: fee}(account, months);
    }

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    function test_constructor_storesTheControllerAndTheConstants() public view {
        assertEq(address(pass.feeController()), address(fees));
        assertEq(pass.PRO_MONTHLY(), KEY);
        assertEq(pass.MONTH(), 30 days);
        assertEq(pass.MAX_MONTHS(), 24);
    }

    function test_constructor_rejectsZeroFeeController() public {
        vm.expectRevert(ProPass.ZeroFeeController.selector);
        new ProPass(IFeeController(address(0)));
    }

    /// A pass built on a controller that lacks the key would be dead for good: its controller is immutable.
    function test_constructor_probesTheFeeKey_revertsWhenMissing() public {
        FeeController bare = new FeeController(feeOwner, feeRecipient);
        vm.expectRevert(abi.encodeWithSelector(FeeController.UnknownKey.selector, KEY));
        new ProPass(bare);
    }

    // ---------------------------------------------------------------------
    // subscribe
    // ---------------------------------------------------------------------

    function test_subscribe_oneMonth_fromNow_andForwardsTheFee() public {
        uint64 until = (block.timestamp + MONTH).toUint64();
        uint256 recipientBefore = feeRecipient.balance;
        vm.expectEmit(true, true, false, true, address(pass));
        emit Subscribed(alice, alice, 1, until);
        _subscribe(alice, alice, 1);
        assertEq(pass.paidUntil(alice), until);
        assertTrue(pass.isPro(alice));
        assertEq(feeRecipient.balance - recipientBefore, PRICE);
        assertEq(address(pass).balance, 0, "the pass holds nothing");
    }

    function test_subscribe_manyMonths_costMonthsTimesThePrice() public {
        uint256 aliceBefore = alice.balance;
        _subscribe(alice, alice, 24);
        assertEq(aliceBefore - alice.balance, 24 * PRICE);
        assertEq(pass.paidUntil(alice), block.timestamp + 24 * MONTH);
    }

    function test_subscribe_whileActive_extendsFromPaidUntil() public {
        _subscribe(alice, alice, 2);
        uint64 first = pass.paidUntil(alice);
        vm.warp(block.timestamp + 10 days);
        _subscribe(alice, alice, 1);
        assertEq(pass.paidUntil(alice), first + MONTH, "time still paid for is kept");
    }

    function test_subscribe_afterExpiry_extendsFromNow() public {
        _subscribe(alice, alice, 1);
        vm.warp(block.timestamp + 100 days);
        assertFalse(pass.isPro(alice));
        _subscribe(alice, alice, 1);
        assertEq(pass.paidUntil(alice), block.timestamp + MONTH, "lapsed time is not paid back");
    }

    function test_subscribe_exactlyAtPaidUntil_extendsFromNow() public {
        _subscribe(alice, alice, 1);
        vm.warp(pass.paidUntil(alice));
        _subscribe(alice, alice, 1);
        assertEq(pass.paidUntil(alice), block.timestamp + MONTH);
    }

    function test_isPro_endsAtPaidUntil() public {
        assertFalse(pass.isPro(alice), "nobody is Pro by default");
        _subscribe(alice, alice, 1);
        vm.warp(pass.paidUntil(alice) - 1);
        assertTrue(pass.isPro(alice));
        vm.warp(pass.paidUntil(alice));
        assertFalse(pass.isPro(alice));
    }

    function test_anyoneCanPayForAnyAccount() public {
        vm.expectEmit(true, true, false, true, address(pass));
        emit Subscribed(bob, alice, 3, (block.timestamp + 3 * MONTH).toUint64());
        _subscribe(alice, bob, 3);
        assertTrue(pass.isPro(bob));
        assertFalse(pass.isPro(alice));
    }

    function test_subscribe_rejectsZeroAndTooManyMonths() public {
        vm.expectRevert(ProPass.BadMonths.selector);
        vm.prank(alice);
        pass.subscribe{value: 0}(alice, 0);
        vm.expectRevert(ProPass.BadMonths.selector);
        vm.prank(alice);
        pass.subscribe{value: 25 * PRICE}(alice, 25);
        assertEq(pass.paidUntil(alice), 0);
    }

    function test_subscribe_takesTheExactFeeOnly() public {
        uint256[4] memory sent = [3 * PRICE - 1, 3 * PRICE + 1, uint256(0), PRICE];
        for (uint256 i; i < sent.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(ProPass.WrongFee.selector, 3 * PRICE, sent[i]));
            vm.prank(alice);
            pass.subscribe{value: sent[i]}(alice, 3);
        }
        assertEq(pass.paidUntil(alice), 0);
        assertEq(feeRecipient.balance, 0);
    }

    function test_aPriceChange_appliesToTheNextSubscriptionOnly() public {
        _subscribe(alice, alice, 1);
        vm.prank(feeOwner);
        fees.setFee(KEY, 5 ether);
        uint256 aliceBefore = alice.balance;
        _subscribe(alice, alice, 2);
        assertEq(aliceBefore - alice.balance, 10 ether);
        assertEq(pass.paidUntil(alice), block.timestamp + 3 * MONTH);
    }

    function test_aZeroPrice_subscribesForFree() public {
        vm.prank(feeOwner);
        fees.setFee(KEY, 0);
        vm.prank(alice);
        pass.subscribe(alice, 1);
        assertTrue(pass.isPro(alice));
    }

    function test_aRecipientThatCannotReceive_blocksSubscriptions() public {
        address payable refuser = payable(address(new MockRevertingReceiver()));
        vm.prank(feeOwner);
        fees.setRecipient(refuser);
        vm.expectRevert(ProPass.FeeTransferFailed.selector);
        vm.prank(alice);
        pass.subscribe{value: PRICE}(alice, 1);
        assertEq(pass.paidUntil(alice), 0);
    }

    function test_thePassRefusesPlainValue() public {
        vm.prank(alice);
        (bool ok,) = address(pass).call{value: 1 ether}("");
        assertFalse(ok);
    }

    // ---------------------------------------------------------------------
    // Fuzz
    // ---------------------------------------------------------------------

    /// Random subscriptions and waits for two accounts: each account's `paidUntil` never decreases, each call adds
    /// exactly `months * MONTH` to the later of now and `paidUntil`, it costs exactly `months * price`, and the pass
    /// never holds anything.
    function testFuzz_paidUntilIsMonotonic_andEachCallAddsExactlyItsMonths(
        uint256[6] memory monthsSeeds,
        uint256[6] memory waits,
        bool[6] memory forBob
    ) public {
        for (uint256 i; i < 6; ++i) {
            address account = forBob[i] ? bob : alice;
            uint256 months = bound(monthsSeeds[i], 1, 24);
            vm.warp(block.timestamp + bound(waits[i], 0, 400 days));
            uint64 before = pass.paidUntil(account);
            uint64 other = pass.paidUntil(forBob[i] ? alice : bob);
            uint256 base = Math.max(before, vm.getBlockTimestamp());
            uint256 payerBefore = alice.balance;
            uint256 recipientBefore = feeRecipient.balance;
            _subscribe(alice, account, months);
            assertGe(pass.paidUntil(account), before, "paidUntil decreased");
            assertEq(pass.paidUntil(account), base + months * MONTH);
            assertEq(pass.paidUntil(forBob[i] ? alice : bob), other, "another account changed");
            assertEq(payerBefore - alice.balance, months * PRICE);
            assertEq(feeRecipient.balance - recipientBefore, months * PRICE);
            assertEq(address(pass).balance, 0);
            assertTrue(pass.isPro(account));
        }
    }

    function testFuzz_onlyTheExactFeeIsAccepted(uint256 months, uint256 sent) public {
        months = bound(months, 1, 24);
        sent = bound(sent, 0, 1_000 ether);
        vm.prank(alice);
        try pass.subscribe{value: sent}(alice, months) {
            assertEq(sent, months * PRICE);
        } catch (bytes memory reason) {
            assertTrue(sent != months * PRICE);
            assertEq(reason, abi.encodeWithSelector(ProPass.WrongFee.selector, months * PRICE, sent));
            assertEq(pass.paidUntil(alice), 0);
        }
        assertEq(address(pass).balance, 0);
    }

    function testFuzz_badMonthsAlwaysRevert(uint256 months) public {
        vm.assume(months == 0 || months > 24);
        vm.expectRevert(ProPass.BadMonths.selector);
        vm.prank(alice);
        pass.subscribe{value: 0}(alice, months);
    }
}
