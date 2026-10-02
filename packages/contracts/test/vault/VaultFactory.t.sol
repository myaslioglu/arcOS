// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IFeeController} from "../../src/interfaces/IFeeController.sol";
import {FeeController} from "../../src/FeeController.sol";
import {LockVault} from "../../src/vault/LockVault.sol";
import {PositionVault} from "../../src/vault/PositionVault.sol";
import {VaultFactory} from "../../src/vault/VaultFactory.sol";
import {VaultTestBase} from "./VaultTestBase.sol";
import {MockReenteringRecipient, MockReenteringToken} from "./mocks/VaultMocks.sol";
import {MockV3PositionManager} from "./mocks/PositionMocks.sol";

contract VaultFactoryTest is VaultTestBase {
    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    function test_constructor_rejectsZeroOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new VaultFactory(address(0), fees);
    }

    function test_constructor_rejectsZeroFeeController() public {
        vm.expectRevert(VaultFactory.ZeroFeeController.selector);
        new VaultFactory(factoryOwner, IFeeController(address(0)));
    }

    function test_constructor_probesEachFeeKey_revertsWhenMissing() public {
        bytes32[3] memory keys = [KEY_FLAT, KEY_LP, KEY_SHARE];
        for (uint256 missing; missing < keys.length; ++missing) {
            FeeController c = new FeeController(feeOwner, feeRecipient);
            vm.startPrank(feeOwner);
            for (uint256 i; i < keys.length; ++i) {
                if (i != missing) c.addKey(keys[i], 1, 1);
            }
            vm.stopPrank();
            vm.expectRevert(abi.encodeWithSelector(FeeController.UnknownKey.selector, keys[missing]));
            new VaultFactory(factoryOwner, c);
        }
    }

    function test_constructor_deploysBothImplementations_initialiserDisabled() public {
        LockVault lockImpl = LockVault(factory.lockVaultImpl());
        address positionImpl = factory.positionVaultImpl();
        assertGt(address(lockImpl).code.length, 0);
        assertGt(positionImpl.code.length, 0);
        uint64 at = uint64(block.timestamp + 1 days);

        vm.expectRevert(Initializable.InvalidInitialization.selector);
        lockImpl.initialize(alice, token, at);

        assertFalse(factory.isVault(address(lockImpl)));
        assertFalse(factory.isVault(positionImpl));
        assertEq(address(factory.feeController()), address(fees));
        assertEq(factory.owner(), factoryOwner);
    }

    function test_constants_matchKeys() public view {
        assertEq(factory.LOCK_FLAT(), keccak256("LOCK_FLAT"));
        assertEq(factory.LOCK_LP_BPS(), keccak256("LOCK_LP_BPS"));
        assertEq(factory.LOCK_FEE_SHARE_BPS(), keccak256("LOCK_FEE_SHARE_BPS"));
    }

    // ---------------------------------------------------------------------
    // lockToken
    // ---------------------------------------------------------------------

    function test_lockToken_createsOneVaultPerLock_andHoldsNothingItself() public {
        LockVault v = _lock(alice, token, 100 ether, 30 days, alice);
        assertTrue(factory.isVault(address(v)));
        assertGt(address(v).code.length, 0);
        assertEq(token.balanceOf(address(v)), 100 ether);
        assertEq(token.balanceOf(address(factory)), 0);
        assertEq(address(factory).balance, 0);
    }

    function test_lockToken_recordsOwnerTokenAndUnlockTime_inTheVault() public {
        LockVault v = _lock(alice, token, 100 ether, 30 days, bob);
        assertEq(v.owner(), bob);
        assertEq(address(v.token()), address(token));
        assertEq(v.unlockAt(), block.timestamp + 30 days);
        assertEq(v.lockedAmount(), 100 ether);
        assertEq(v.pendingOwner(), address(0));
    }

    function test_lockToken_forwardsTheFlatFee_inTheSameCall() public {
        uint256 recipientBefore = feeRecipient.balance;
        uint256 aliceBefore = alice.balance;
        _lock(alice, token, 1 ether, 1 days, alice);
        assertEq(feeRecipient.balance, recipientBefore + FLAT);
        assertEq(alice.balance, aliceBefore - FLAT);
        assertEq(address(factory).balance, 0);
    }

    function test_lockToken_registersUnderTheGivenOwner_notTheCaller() public {
        LockVault v = _lock(alice, token, 1 ether, 30 days, bob);
        address[] memory bobs = factory.vaultsOf(bob);
        assertEq(bobs.length, 1);
        assertEq(bobs[0], address(v));
        assertEq(factory.vaultsOf(alice).length, 0);
        address[] memory forToken = factory.vaultsForToken(address(token));
        assertEq(forToken.length, 1);
        assertEq(forToken[0], address(v));
    }

    function test_lockToken_twoLocksGetTwoVaults_noSharedPool() public {
        LockVault first = _lock(alice, token, 10 ether, 30 days, alice);
        LockVault second = _lock(alice, token, 20 ether, 30 days, alice);
        assertTrue(address(first) != address(second));
        assertEq(token.balanceOf(address(first)), 10 ether);
        assertEq(token.balanceOf(address(second)), 20 ether);

        vm.warp(block.timestamp + 30 days);
        vm.prank(alice);
        first.withdraw(alice);
        assertEq(token.balanceOf(address(first)), 0);
        assertEq(token.balanceOf(address(second)), 20 ether); // the other lock is untouched
        assertEq(token.balanceOf(address(factory)), 0);
    }

    function test_lockToken_vaultIsAFixedMinimalProxy() public {
        LockVault v = _lock(alice, token, 1 ether, 30 days, alice);
        // ERC-1167: a fixed 45-byte forwarder to lockVaultImpl. It has no admin and no upgrade path of its own.
        bytes memory expected =
            abi.encodePacked(hex"363d3d373d3d3d363d73", factory.lockVaultImpl(), hex"5af43d82803e903d91602b57fd5bf3");
        assertEq(expected.length, 45);
        assertEq(address(v).code, expected);
    }

    function test_lockToken_emitsTokenLocked() public {
        Snap memory s = _snap(bob, address(token));
        uint64 at = uint64(block.timestamp + 30 days);
        vm.expectEmit(true, true, false, true, address(factory));
        emit VaultFactory.TokenLocked(bob, address(token), s.predicted, 100 ether, 0, at);
        vm.prank(alice);
        address vault = factory.lockToken{value: FLAT}(token, 100 ether, at, bob);
        assertEq(vault, s.predicted);
    }

    function test_lockToken_revertsOnWrongFee() public {
        Snap memory s = _snap(alice, address(token));
        uint64 at = uint64(block.timestamp + 30 days);
        uint256[4] memory sent = [uint256(0), FLAT - 1, FLAT + 1, 2 * FLAT];
        for (uint256 i; i < sent.length; ++i) {
            vm.prank(alice);
            vm.expectRevert(abi.encodeWithSelector(VaultFactory.WrongFee.selector, FLAT, sent[i]));
            factory.lockToken{value: sent[i]}(token, 1 ether, at, alice);
        }
        _assertNothingLeftBehind(s, alice, address(token));
        assertEq(token.balanceOf(alice), START_BALANCE);
    }

    function test_lockToken_revertsOnZeroAmount_zeroOwner_badUnlockTimes() public {
        Snap memory s = _snap(alice, address(token));
        uint64 nowTs = uint64(block.timestamp);
        vm.startPrank(alice);
        vm.expectRevert(VaultFactory.ZeroAmount.selector);
        factory.lockToken{value: FLAT}(token, 0, nowTs + 1 days, alice);
        vm.expectRevert(LockVault.ZeroAddress.selector);
        factory.lockToken{value: FLAT}(token, 1 ether, nowTs + 1 days, address(0));
        vm.expectRevert(LockVault.BadUnlockTime.selector);
        factory.lockToken{value: FLAT}(token, 1 ether, nowTs, alice);
        vm.expectRevert(LockVault.BadUnlockTime.selector);
        factory.lockToken{value: FLAT}(token, 1 ether, 0, alice);
        vm.expectRevert(LockVault.BadUnlockTime.selector);
        factory.lockToken{value: FLAT}(token, 1 ether, nowTs + 3650 days + 1, alice);
        vm.stopPrank();
        _assertNothingLeftBehind(s, alice, address(token));
    }

    function test_lockToken_revertsForAnAddressThatIsNotAToken() public {
        address eoa = makeAddr("eoa");
        Snap memory s = _snap(alice, eoa);
        uint64 at = uint64(block.timestamp + 30 days);
        vm.startPrank(alice);
        vm.expectRevert(VaultFactory.NotAToken.selector);
        factory.lockToken{value: FLAT}(IERC20(eoa), 1 ether, at, alice);
        vm.expectRevert(VaultFactory.NotAToken.selector);
        factory.lockToken{value: FLAT}(IERC20(address(0)), 1 ether, at, alice);
        vm.stopPrank();
        _assertNothingLeftBehind(s, alice, eoa);
    }

    function test_lockToken_movesOnlyTheCallersTokens() public {
        address carol = makeAddr("carol");
        vm.deal(carol, 100 ether);
        uint256 aliceBalance = token.balanceOf(alice);
        uint256 aliceAllowance = token.allowance(alice, address(factory));
        uint64 at = uint64(block.timestamp + 30 days);

        // Carol has no allowance: alice's approval is not hers to spend.
        vm.prank(carol);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(factory), 0, 1 ether)
        );
        factory.lockToken{value: FLAT}(token, 1 ether, at, carol);

        // With an allowance but no balance, it fails on carol's own balance.
        vm.prank(carol);
        token.approve(address(factory), type(uint256).max);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, carol, 0, 1 ether));
        factory.lockToken{value: FLAT}(token, 1 ether, at, carol);

        assertEq(token.balanceOf(alice), aliceBalance);
        assertEq(token.allowance(alice, address(factory)), aliceAllowance);
    }

    function test_lockToken_isNonReentrant_forAHostileToken() public {
        MockReenteringToken hostile = new MockReenteringToken();
        hostile.mint(alice, 100 ether);
        hostile.arm(factory);
        vm.prank(alice);
        hostile.approve(address(factory), type(uint256).max);

        LockVault v = _lock(alice, IERC20(address(hostile)), 10 ether, 30 days, alice);

        assertEq(hostile.seen(), abi.encodeWithSelector(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector));
        assertEq(factory.vaultsForTokenLength(address(hostile)), 1);
        assertEq(hostile.balanceOf(address(v)), 10 ether);
    }

    function test_lockToken_isNonReentrant_forAReenteringFeeRecipient() public {
        MockReenteringRecipient rec = new MockReenteringRecipient(factory, token);
        vm.prank(feeOwner);
        fees.setRecipient(payable(address(rec)));

        _lock(alice, token, 10 ether, 30 days, alice);

        assertEq(rec.seen(), abi.encodeWithSelector(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector));
        assertEq(rec.received(), FLAT);
        assertEq(address(rec).balance, FLAT); // the nested attempt reverted, so the fee it tried to send on is still here
        assertEq(factory.vaultsForTokenLength(address(token)), 1);
    }

    function test_factoryRejectsNativeValueSentDirectly() public {
        (bool ok,) = address(factory).call{value: 1}("");
        assertFalse(ok);
        (bool okEmpty,) = address(factory).call("");
        assertFalse(okEmpty);
        assertEq(address(factory).balance, 0);
    }

    // ---------------------------------------------------------------------
    // lockPosition: the guards that exist before the position vault does
    // ---------------------------------------------------------------------

    function test_lockPosition_revertsOnWrongFee() public {
        address manager = makeAddr("manager");
        uint64 at = uint64(block.timestamp + 1 days);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(VaultFactory.WrongFee.selector, FLAT, 0));
        factory.lockPosition(manager, 1, at, alice);
    }

    function test_lockPosition_rejectsAnUnlistedManager() public {
        address manager = makeAddr("manager");
        uint64 at = uint64(block.timestamp + 1 days);
        vm.prank(alice);
        vm.expectRevert(VaultFactory.ManagerNotAllowed.selector);
        factory.lockPosition{value: FLAT}(manager, 1, at, alice);
    }

    function test_lockPosition_rejectsAFeeShareAboveTenThousandBps() public {
        address manager = makeAddr("manager");
        uint64 at = uint64(block.timestamp + 1 days);
        // 10,001 is over; 65,736 would wrap to 200 in a uint16 cast; the last is the largest possible value.
        uint256[3] memory bad = [uint256(10_001), uint256(65_536 + 200), type(uint256).max];
        for (uint256 i; i < bad.length; ++i) {
            FeeController c = _newFeeController(FLAT, FLAT_CAP, LP_BPS, LP_BPS_CAP, bad[i], type(uint256).max);
            VaultFactory f = new VaultFactory(factoryOwner, c);
            vm.prank(factoryOwner);
            f.setManager(manager, true, PositionVault.Kind.V3);
            vm.prank(alice);
            vm.expectRevert(abi.encodeWithSelector(VaultFactory.FeeOutOfRange.selector, KEY_SHARE, bad[i]));
            f.lockPosition{value: FLAT}(manager, 1, at, alice);
        }
    }

    function test_lockPosition_feeShareBound_includesTenThousand() public {
        uint64 at = uint64(block.timestamp + 1 days);
        FeeController c = _newFeeController(FLAT, FLAT_CAP, LP_BPS, LP_BPS_CAP, 10_000, 10_000);
        VaultFactory f = new VaultFactory(factoryOwner, c);
        MockV3PositionManager v3 = new MockV3PositionManager();
        vm.prank(factoryOwner);
        f.setManager(address(v3), true, PositionVault.Kind.V3);
        uint256 id = v3.mint(alice, address(token), address(pair), 1);
        vm.startPrank(alice);
        v3.approve(address(f), id);
        // 10,000 passes the bound, and the vault keeps it.
        PositionVault vault = PositionVault(payable(f.lockPosition{value: FLAT}(address(v3), id, at, alice)));
        vm.stopPrank();
        assertEq(vault.feeShareBps(), 10_000);
    }

    // ---------------------------------------------------------------------
    // The position-manager allow-list, and the factory's own two-step ownership
    // ---------------------------------------------------------------------

    function test_setManager_ownerOnly_setsAndEmits() public {
        address manager = makeAddr("manager");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        factory.setManager(manager, true, PositionVault.Kind.V3);

        vm.expectEmit(true, false, false, true, address(factory));
        emit VaultFactory.ManagerSet(manager, true, PositionVault.Kind.V4);
        vm.prank(factoryOwner);
        factory.setManager(manager, true, PositionVault.Kind.V4);

        (bool allowed, PositionVault.Kind kind) = factory.managers(manager);
        assertTrue(allowed);
        assertEq(uint8(kind), uint8(PositionVault.Kind.V4));
    }

    function test_setManager_canDisallowAndChangeKind() public {
        address manager = makeAddr("manager");
        vm.startPrank(factoryOwner);
        factory.setManager(manager, true, PositionVault.Kind.V3);
        factory.setManager(manager, true, PositionVault.Kind.V4);
        (bool allowed, PositionVault.Kind kind) = factory.managers(manager);
        assertTrue(allowed);
        assertEq(uint8(kind), uint8(PositionVault.Kind.V4));

        factory.setManager(manager, false, PositionVault.Kind.V3);
        (allowed, kind) = factory.managers(manager);
        assertFalse(allowed);
        assertEq(uint8(kind), uint8(PositionVault.Kind.V3));
        vm.stopPrank();
    }

    function test_ownership_isTwoStep() public {
        address next = makeAddr("next");
        address manager = makeAddr("manager");
        vm.prank(factoryOwner);
        factory.transferOwnership(next);
        assertEq(factory.owner(), factoryOwner);
        assertEq(factory.pendingOwner(), next);

        vm.prank(next); // a pending owner has no power yet
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, next));
        factory.setManager(manager, true, PositionVault.Kind.V3);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        factory.acceptOwnership();

        vm.prank(next);
        factory.acceptOwnership();
        assertEq(factory.owner(), next);
        assertEq(factory.pendingOwner(), address(0));

        vm.prank(factoryOwner); // the old owner has none any more
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, factoryOwner));
        factory.setManager(manager, true, PositionVault.Kind.V3);

        vm.prank(next);
        factory.setManager(manager, true, PositionVault.Kind.V3);
    }

    /// Pins today's behaviour, which is OpenZeppelin's default: the owner can renounce, in one step and for good.
    /// That freezes the allow-list as it stands (it can no longer add or remove a manager) and touches nothing else.
    /// It is listed as an open question for the audit's threat model.
    function test_renounceOwnership_isOneWay_andFreezesTheAllowList() public {
        address manager = makeAddr("manager");
        vm.startPrank(factoryOwner);
        factory.setManager(manager, true, PositionVault.Kind.V3);
        factory.renounceOwnership();
        vm.stopPrank();
        assertEq(factory.owner(), address(0));

        vm.prank(factoryOwner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, factoryOwner));
        factory.setManager(manager, false, PositionVault.Kind.V3);
        (bool allowed,) = factory.managers(manager);
        assertTrue(allowed); // frozen as it was

        LockVault v = _lock(alice, token, 1 ether, 30 days, alice); // locking never depended on the owner
        assertTrue(factory.isVault(address(v)));
    }

    function test_isVault_isTrueOnlyForFactoryVaults() public {
        LockVault real = _lock(alice, token, 1 ether, 30 days, alice);
        // Anyone can clone the public implementation and initialise the clone. It is not the factory's vault.
        LockVault lookalike = LockVault(Clones.clone(factory.lockVaultImpl()));
        lookalike.initialize(alice, token, uint64(block.timestamp + 30 days));

        assertTrue(factory.isVault(address(real)));
        assertFalse(factory.isVault(address(lookalike)));
        assertFalse(factory.isVault(factory.lockVaultImpl()));
        assertFalse(factory.isVault(factory.positionVaultImpl()));
        assertFalse(factory.isVault(address(factory)));
        assertFalse(factory.isVault(alice));
    }
}
