// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {FeeController} from "../../src/FeeController.sol";
import {IFeeController} from "../../src/interfaces/IFeeController.sol";
import {ArcVesting} from "../../src/vesting/ArcVesting.sol";
import {VestingFactory} from "../../src/vesting/VestingFactory.sol";
import {VestingTestBase} from "./VestingTestBase.sol";
import {
    MockFeeOnTransferToken,
    MockRebasingToken,
    MockRevertingReceiver,
    MockToken
} from "../vault/mocks/VaultMocks.sol";
import {MockLyingToken, MockVestingReenteringToken} from "./mocks/VestingMocks.sol";

contract VestingFactoryTest is VestingTestBase {
    uint256 internal constant AMOUNT = 1_000 ether;

    event VestingCreated(
        address indexed creator,
        address indexed token,
        address indexed beneficiary,
        address vesting,
        uint256 amount,
        uint64 start,
        uint64 duration,
        uint64 cliff
    );

    /// What a failed creation must leave exactly as it found it.
    struct Snap {
        uint256 ofBeneficiary;
        uint256 forToken;
        uint256 nonce;
        address predicted;
        uint256 aliceTokens;
        uint256 recipientNative;
    }

    function _snap(address beneficiary, address t) internal view returns (Snap memory s) {
        s.ofBeneficiary = factory.vestingsOfLength(beneficiary);
        s.forToken = factory.vestingsForTokenLength(t);
        s.nonce = vm.getNonce(address(factory));
        s.predicted = vm.computeCreateAddress(address(factory), s.nonce);
        s.aliceTokens = IERC20(t).balanceOf(alice);
        s.recipientNative = feeRecipient.balance;
    }

    function _assertNothingLeftBehind(Snap memory s, address beneficiary, address t) internal view {
        assertEq(factory.vestingsOfLength(beneficiary), s.ofBeneficiary, "vestingsOf grew");
        assertEq(factory.vestingsForTokenLength(t), s.forToken, "vestingsForToken grew");
        assertEq(vm.getNonce(address(factory)), s.nonce, "the factory's nonce moved");
        assertFalse(factory.isVesting(s.predicted), "the would-be wallet is registered");
        assertEq(s.predicted.code.length, 0, "the would-be wallet has code");
        assertEq(IERC20(t).balanceOf(alice), s.aliceTokens, "the creator's tokens moved");
        assertEq(feeRecipient.balance, s.recipientNative, "a fee was paid");
        assertEq(address(factory).balance, 0, "the factory holds value");
    }

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    function test_constructor_storesTheControllerAndTheConstants() public view {
        assertEq(address(factory.feeController()), address(fees));
        assertEq(factory.VEST_FLAT(), keccak256("VEST_FLAT"));
        assertEq(factory.MAX_DURATION(), 3650 days);
        assertEq(factory.MAX_AMOUNT(), type(uint256).max / 3650 days);
    }

    function test_constructor_rejectsZeroFeeController() public {
        vm.expectRevert(VestingFactory.ZeroFeeController.selector);
        new VestingFactory(IFeeController(address(0)));
    }

    /// A factory built on a controller that lacks the key would be dead for good: its controller is immutable.
    function test_constructor_probesTheFeeKey_revertsWhenMissing() public {
        FeeController bare = new FeeController(feeOwner, feeRecipient);
        vm.expectRevert(abi.encodeWithSelector(FeeController.UnknownKey.selector, KEY_VEST));
        new VestingFactory(bare);
    }

    // ---------------------------------------------------------------------
    // createVesting: the happy path
    // ---------------------------------------------------------------------

    function test_createVesting_makesAFundedWallet_andOnlyTheFeeMovesToTheRecipient() public {
        uint64 start = uint64(block.timestamp + 1 days);
        uint256 aliceTokens = token.balanceOf(alice);
        uint256 aliceNative = alice.balance;
        uint256 recipientNative = feeRecipient.balance;
        address predicted = vm.computeCreateAddress(address(factory), vm.getNonce(address(factory)));

        vm.expectEmit(true, true, true, true, address(factory));
        emit VestingCreated(alice, address(token), bob, predicted, AMOUNT, start, 365 days, 90 days);
        ArcVesting w = _create(alice, token, bob, AMOUNT, start, 365 days, 90 days);

        assertEq(address(w), predicted);
        assertEq(w.owner(), bob);
        assertEq(w.start(), start);
        assertEq(w.duration(), 365 days);
        assertEq(w.cliff(), start + 90 days);
        assertEq(token.balanceOf(address(w)), AMOUNT, "the wallet holds the amount");
        assertEq(aliceTokens - token.balanceOf(alice), AMOUNT, "the creator paid the amount");
        assertEq(aliceNative - alice.balance, VEST_FEE, "the creator paid the fee");
        assertEq(feeRecipient.balance - recipientNative, VEST_FEE, "the recipient got the fee");
        assertEq(token.balanceOf(feeRecipient), 0, "no tokens go to the recipient");
        assertEq(token.balanceOf(address(factory)), 0, "the factory holds no tokens");
        assertEq(address(factory).balance, 0, "the factory holds no value");
        assertEq(address(w).balance, 0, "the wallet holds no value");
        assertTrue(factory.isVesting(address(w)));
    }

    /// One wallet per schedule: the same arguments twice make two wallets, each with its own tokens.
    function test_oneWalletPerSchedule() public {
        ArcVesting a = _createStandard(AMOUNT);
        ArcVesting b = _createStandard(AMOUNT);
        assertTrue(address(a) != address(b));
        assertEq(token.balanceOf(address(a)), AMOUNT);
        assertEq(token.balanceOf(address(b)), AMOUNT);
        vm.warp(a.end());
        a.release(address(token));
        assertEq(token.balanceOf(address(b)), AMOUNT, "releasing one wallet never touches another");
    }

    function test_anyoneCanCreateForAnyBeneficiary_andTheCreatorHasNoPowerOverIt() public {
        ArcVesting w = _create(alice, token, carol, AMOUNT, uint64(block.timestamp), 10 days, 0);
        assertEq(w.owner(), carol);
        vm.warp(w.end());
        vm.prank(alice);
        w.release(address(token));
        assertEq(token.balanceOf(carol), AMOUNT, "a release by the creator still pays the beneficiary");
    }

    // ---------------------------------------------------------------------
    // The fee
    // ---------------------------------------------------------------------

    function test_createVesting_revertsOnTooLittleTooMuchOrNoFee() public {
        uint256[3] memory sent = [VEST_FEE - 1, VEST_FEE + 1, uint256(0)];
        for (uint256 i; i < sent.length; ++i) {
            Snap memory s = _snap(bob, address(token));
            vm.expectRevert(abi.encodeWithSelector(VestingFactory.WrongFee.selector, VEST_FEE, sent[i]));
            vm.prank(alice);
            factory.createVesting{value: sent[i]}(token, bob, AMOUNT, uint64(block.timestamp), 365 days, 0);
            _assertNothingLeftBehind(s, bob, address(token));
        }
    }

    function test_feeIsReadAtCreation_aLaterChangeNeverReachesAnExistingWallet() public {
        ArcVesting w = _createStandard(AMOUNT);
        vm.prank(feeOwner);
        fees.setFee(KEY_VEST, 5 ether); // a decrease applies at once
        ArcVesting w2 = _createStandard(AMOUNT);
        assertEq(feeRecipient.balance, VEST_FEE + 5 ether);

        vm.prank(feeOwner);
        fees.setFee(KEY_VEST, VEST_FEE_CAP); // an increase waits 48 hours
        vm.warp(block.timestamp + 48 hours);
        fees.applyPending(KEY_VEST);
        vm.warp(w.end());
        uint256 recipientBefore = feeRecipient.balance;
        w.release(address(token));
        w2.release(address(token));
        assertEq(token.balanceOf(bob), START_BALANCE + 2 * AMOUNT, "releases are never charged");
        assertEq(feeRecipient.balance, recipientBefore);
        vm.expectRevert(abi.encodeWithSelector(VestingFactory.WrongFee.selector, VEST_FEE_CAP, VEST_FEE));
        vm.prank(alice);
        factory.createVesting{value: VEST_FEE}(token, bob, AMOUNT, uint64(block.timestamp), 365 days, 0);
    }

    function test_aZeroFee_isAccepted() public {
        vm.prank(feeOwner);
        fees.setFee(KEY_VEST, 0);
        vm.prank(alice);
        address w = factory.createVesting(token, bob, AMOUNT, uint64(block.timestamp), 365 days, 0);
        assertTrue(factory.isVesting(w));
    }

    function test_aRecipientThatCannotReceive_blocksCreation_andLeavesNothingBehind() public {
        address payable refuser = payable(address(new MockRevertingReceiver()));
        vm.prank(feeOwner);
        fees.setRecipient(refuser);
        Snap memory s = _snap(bob, address(token));
        s.recipientNative = fees.recipient().balance;
        vm.expectRevert(VestingFactory.FeeTransferFailed.selector);
        vm.prank(alice);
        factory.createVesting{value: VEST_FEE}(token, bob, AMOUNT, uint64(block.timestamp), 365 days, 0);
        assertEq(factory.vestingsOfLength(bob), s.ofBeneficiary);
        assertEq(vm.getNonce(address(factory)), s.nonce);
        assertEq(token.balanceOf(alice), s.aliceTokens);
    }

    function test_theFactoryRefusesPlainValue() public {
        vm.prank(alice);
        (bool ok,) = address(factory).call{value: 1 ether}("");
        assertFalse(ok);
    }

    // ---------------------------------------------------------------------
    // Arguments
    // ---------------------------------------------------------------------

    function test_createVesting_rejectsAZeroAmount() public {
        Snap memory s = _snap(bob, address(token));
        vm.expectRevert(VestingFactory.ZeroAmount.selector);
        vm.prank(alice);
        factory.createVesting{value: VEST_FEE}(token, bob, 0, uint64(block.timestamp), 365 days, 0);
        _assertNothingLeftBehind(s, bob, address(token));
    }

    /// Above `MAX_AMOUNT`, OpenZeppelin's `totalAllocation * elapsed` could overflow between the cliff and the end, and
    /// every release would revert until the schedule ends.
    function test_createVesting_rejectsAnAmountTheCurveCannotMultiply() public {
        uint256 max = factory.MAX_AMOUNT();
        token.mint(alice, max + 1);
        Snap memory s = _snap(bob, address(token));
        vm.expectRevert(VestingFactory.AmountTooLarge.selector);
        vm.prank(alice);
        factory.createVesting{value: VEST_FEE}(token, bob, max + 1, uint64(block.timestamp), MAX_DURATION, 0);
        _assertNothingLeftBehind(s, bob, address(token));

        ArcVesting w = _create(alice, token, bob, max, uint64(block.timestamp), MAX_DURATION, 0);
        vm.warp(w.end() - 1);
        assertEq(w.releasable(address(token)), (max * (MAX_DURATION - 1)) / MAX_DURATION, "the largest amount works");
    }

    function test_createVesting_rejectsBadSchedules() public {
        uint64 nowTs = uint64(block.timestamp);
        uint64[3][6] memory bad = [
            [nowTs, uint64(0), uint64(0)], // no duration
            [nowTs, MAX_DURATION + 1, uint64(0)], // too long
            [nowTs, uint64(100 days), uint64(100 days + 1)], // cliff past the end
            [nowTs + MAX_DURATION + 1, uint64(100 days), uint64(0)], // starts too far out
            [type(uint64).max, uint64(100 days), uint64(1)], // would overflow the cliff time
            [type(uint64).max - 1 days, uint64(1 days), uint64(0)] // starts too far out (near uint64 max)
        ];
        for (uint256 i; i < bad.length; ++i) {
            Snap memory s = _snap(bob, address(token));
            vm.expectRevert(VestingFactory.BadSchedule.selector);
            vm.prank(alice);
            factory.createVesting{value: VEST_FEE}(token, bob, AMOUNT, bad[i][0], bad[i][1], bad[i][2]);
            _assertNothingLeftBehind(s, bob, address(token));
        }
    }

    function test_createVesting_acceptsTheEdgesOfTheWindow() public {
        uint64 nowTs = uint64(block.timestamp);
        ArcVesting a = _create(alice, token, bob, AMOUNT, nowTs, MAX_DURATION, MAX_DURATION);
        assertEq(a.cliff(), a.end(), "the longest duration, with the cliff at the end");
        ArcVesting b = _create(alice, token, bob, AMOUNT, nowTs + MAX_DURATION, 1, 0);
        assertEq(b.start(), nowTs + MAX_DURATION, "the latest start");
        ArcVesting c = _create(alice, token, bob, AMOUNT, 0, 1, 1);
        assertEq(c.releasable(address(token)), AMOUNT, "a start long past vests at once");
    }

    function test_createVesting_rejectsAZeroBeneficiary() public {
        Snap memory s = _snap(address(0), address(token));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        vm.prank(alice);
        factory.createVesting{value: VEST_FEE}(token, address(0), AMOUNT, uint64(block.timestamp), 365 days, 0);
        _assertNothingLeftBehind(s, address(0), address(token));
    }

    function test_createVesting_rejectsAnAddressThatIsNotAToken() public {
        address notAToken = makeAddr("eoa");
        Snap memory s = _snap(bob, address(token));
        vm.expectRevert(VestingFactory.NotAToken.selector);
        vm.prank(alice);
        factory.createVesting{value: VEST_FEE}(IERC20(notAToken), bob, AMOUNT, uint64(block.timestamp), 365 days, 0);
        _assertNothingLeftBehind(s, bob, address(token));
        assertEq(factory.vestingsForTokenLength(notAToken), 0);
    }

    function test_createVesting_withoutAllowance_reverts() public {
        MockToken other = new MockToken();
        other.mint(alice, AMOUNT);
        Snap memory s = _snap(bob, address(other));
        vm.expectRevert();
        vm.prank(alice);
        factory.createVesting{value: VEST_FEE}(other, bob, AMOUNT, uint64(block.timestamp), 365 days, 0);
        _assertNothingLeftBehind(s, bob, address(other));
    }

    // ---------------------------------------------------------------------
    // Awkward tokens: record what arrived, never reject a shortfall
    // ---------------------------------------------------------------------

    function test_feeOnTransfer_theEventReportsWhatArrived() public {
        MockFeeOnTransferToken taxed = new MockFeeOnTransferToken(100); // 1%
        taxed.mint(alice, 10_000 ether);
        vm.prank(alice);
        taxed.approve(address(factory), type(uint256).max);
        address predicted = vm.computeCreateAddress(address(factory), vm.getNonce(address(factory)));
        vm.expectEmit(true, true, true, true, address(factory));
        emit VestingCreated(alice, address(taxed), bob, predicted, 990 ether, uint64(block.timestamp), 100 days, 0);
        _create(alice, IERC20(address(taxed)), bob, 1_000 ether, uint64(block.timestamp), 100 days, 0);
        assertEq(taxed.balanceOf(predicted), 990 ether);
    }

    function test_rebasing_theEventReportsWhatArrived() public {
        MockRebasingToken reb = new MockRebasingToken();
        reb.mint(alice, 10_000 ether);
        reb.rebase(1.5e18);
        vm.prank(alice);
        reb.approve(address(factory), type(uint256).max);
        vm.recordLogs();
        ArcVesting w = _create(alice, IERC20(address(reb)), bob, 1_001, uint64(block.timestamp), 100 days, 0);
        uint256 landed = reb.balanceOf(address(w));
        assertLt(landed, 1_001, "the rebasing token delivers a little less than asked");
        assertEq(_lastCreatedAmount(), landed);
    }

    function test_aTokenThatDeliversNothing_isRefused() public {
        MockLyingToken liar = new MockLyingToken();
        liar.mint(alice, AMOUNT);
        Snap memory s = _snap(bob, address(liar));
        vm.expectRevert(VestingFactory.ZeroAmount.selector);
        vm.prank(alice);
        factory.createVesting{value: VEST_FEE}(IERC20(address(liar)), bob, AMOUNT, uint64(block.timestamp), 1 days, 0);
        _assertNothingLeftBehind(s, bob, address(liar));
    }

    /// Tokens sent to the wallet's address before it exists are the beneficiary's too, but they are not what the
    /// creator funded, so the event leaves them out.
    function test_tokensSentAheadToThePredictedAddress_areNotCountedAsFunding() public {
        address predicted = vm.computeCreateAddress(address(factory), vm.getNonce(address(factory)));
        vm.prank(bob);
        assertTrue(token.transfer(predicted, 7 ether));
        vm.expectEmit(true, true, true, true, address(factory));
        emit VestingCreated(alice, address(token), bob, predicted, AMOUNT, uint64(block.timestamp), 100 days, 0);
        ArcVesting w = _create(alice, token, bob, AMOUNT, uint64(block.timestamp), 100 days, 0);
        assertEq(token.balanceOf(address(w)), AMOUNT + 7 ether);
    }

    function test_createVesting_isNotReentrant() public {
        MockVestingReenteringToken ren = new MockVestingReenteringToken();
        ren.mint(alice, AMOUNT);
        ren.mint(address(ren), AMOUNT);
        vm.prank(alice);
        ren.approve(address(factory), type(uint256).max);
        ren.arm(factory);
        _create(alice, IERC20(address(ren)), bob, AMOUNT, uint64(block.timestamp), 1 days, 0);
        assertEq(ren.seen(), abi.encodeWithSelector(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector));
        assertEq(factory.vestingsForTokenLength(address(ren)), 1);
    }

    // ---------------------------------------------------------------------
    // Registries
    // ---------------------------------------------------------------------

    function test_registries_recordEachWalletUnderItsBeneficiaryAndToken_inOrder() public {
        MockToken other = new MockToken();
        other.mint(alice, AMOUNT);
        vm.prank(alice);
        other.approve(address(factory), type(uint256).max);
        ArcVesting a = _createStandard(AMOUNT);
        ArcVesting b = _create(alice, token, carol, AMOUNT, uint64(block.timestamp), 10 days, 0);
        ArcVesting c = _create(alice, IERC20(address(other)), bob, AMOUNT, uint64(block.timestamp), 10 days, 0);

        address[] memory ofBob = factory.vestingsOf(bob);
        assertEq(ofBob.length, 2);
        assertEq(ofBob[0], address(a));
        assertEq(ofBob[1], address(c));
        assertEq(factory.vestingsOfLength(bob), 2);
        assertEq(factory.vestingsOf(carol)[0], address(b));
        address[] memory forToken = factory.vestingsForToken(address(token));
        assertEq(forToken.length, 2);
        assertEq(forToken[0], address(a));
        assertEq(forToken[1], address(b));
        assertEq(factory.vestingsForTokenLength(address(other)), 1);
        assertEq(factory.vestingsForToken(address(other))[0], address(c));
        assertEq(factory.vestingsOfLength(alice), 0, "the creator is not a beneficiary");
        assertFalse(factory.isVesting(address(token)));
    }

    /// The registry is a discovery hint, keyed by the beneficiary at creation. After a transfer the wallet's own
    /// `owner()` is the truth.
    function test_registry_doesNotFollowAnOwnershipTransfer() public {
        ArcVesting w = _createStandard(AMOUNT);
        vm.prank(bob);
        w.transferOwnership(carol);
        assertEq(factory.vestingsOfLength(bob), 1);
        assertEq(factory.vestingsOfLength(carol), 0);
        assertEq(w.owner(), carol);
    }

    function test_slices_clampToTheEnd_andNeverRevert() public {
        address[] memory made = new address[](5);
        for (uint256 i; i < 5; ++i) {
            made[i] = address(_createStandard(AMOUNT));
        }
        _checkSlice(factory.vestingsOfSlice(bob, 0, 5), made, 0, 5);
        _checkSlice(factory.vestingsOfSlice(bob, 1, 2), made, 1, 2);
        _checkSlice(factory.vestingsOfSlice(bob, 3, 10), made, 3, 2);
        _checkSlice(factory.vestingsOfSlice(bob, 4, type(uint256).max), made, 4, 1);
        _checkSlice(factory.vestingsOfSlice(bob, 2, 0), made, 2, 0);
        _checkSlice(factory.vestingsOfSlice(bob, 5, 1), made, 5, 0);
        _checkSlice(factory.vestingsOfSlice(bob, type(uint256).max, type(uint256).max), made, 0, 0);
        _checkSlice(factory.vestingsOfSlice(carol, 0, 10), made, 0, 0);

        _checkSlice(factory.vestingsForTokenSlice(address(token), 0, 5), made, 0, 5);
        _checkSlice(factory.vestingsForTokenSlice(address(token), 2, 2), made, 2, 2);
        _checkSlice(factory.vestingsForTokenSlice(address(token), 4, type(uint256).max), made, 4, 1);
        _checkSlice(factory.vestingsForTokenSlice(address(token), 9, 1), made, 0, 0);
        _checkSlice(factory.vestingsForTokenSlice(stranger, 0, 1), made, 0, 0);
    }

    function _checkSlice(address[] memory got, address[] memory all, uint256 from, uint256 count) internal pure {
        assertEq(got.length, count, "slice length");
        for (uint256 i; i < count; ++i) {
            assertEq(got[i], all[from + i], "slice entry");
        }
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    /// The amount in the last `VestingCreated` event recorded since `vm.recordLogs()`.
    function _lastCreatedAmount() internal view returns (uint256 amount) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = logs.length; i > 0; --i) {
            if (logs[i - 1].emitter == address(factory) && logs[i - 1].topics[0] == VestingCreated.selector) {
                (, amount,,,) = abi.decode(logs[i - 1].data, (address, uint256, uint64, uint64, uint64));
                return amount;
            }
        }
        revert("no VestingCreated event");
    }
}
