// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {PositionVault} from "../../src/vault/PositionVault.sol";
import {VaultFactory} from "../../src/vault/VaultFactory.sol";
import {PositionTestBase} from "./PositionTestBase.sol";
import {MockToken} from "./mocks/VaultMocks.sol";
import {MockHostileToken, MockSwitchableReceiver, MockV3PositionManager} from "./mocks/PositionMocks.sol";

/// An owner that tries to collect again from inside the native payment it receives from `collect`.
contract ReenteringOwner {
    PositionVault public vault;
    bytes public seen;

    function setVault(PositionVault vault_) external {
        vault = vault_;
    }

    function collect() external {
        vault.collect();
    }

    function acceptOwnership() external {
        vault.acceptOwnership();
    }

    receive() external payable {
        if (seen.length == 0) {
            try vault.collect() {}
            catch (bytes memory reason) {
                seen = reason;
            }
        }
    }
}

/// An owner contract that tries to collect from inside the NFT transfer its own withdraw makes.
contract ReenteringNftOwner {
    PositionVault public vault;

    function setVault(PositionVault vault_) external {
        vault = vault_;
    }

    function acceptOwnership() external {
        vault.acceptOwnership();
    }

    function withdraw() external {
        vault.withdraw(address(this));
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        vault.collect();
        return this.onERC721Received.selector;
    }
}

/// An owner contract that cannot receive native value.
contract NativeRefusingOwner {
    PositionVault public vault;

    function setVault(PositionVault vault_) external {
        vault = vault_;
    }

    function acceptOwnership() external {
        vault.acceptOwnership();
    }

    function collect() external {
        vault.collect();
    }
}

/// PositionVault's unit tests, with mock v3 and v4 managers. The fork suite (test/fork) runs the same flows against the
/// real managers.
contract PositionVaultTest is PositionTestBase {
    uint256 internal constant BPS = 10_000;

    // ---------------------------------------------------------------------
    // Initialisation
    // ---------------------------------------------------------------------

    function test_implementation_cannotBeInitialised() public {
        PositionVault impl = PositionVault(payable(factory.positionVaultImpl()));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(
            alice, address(v3), 1, uint64(block.timestamp + 1 days), PositionVault.Kind.V3, 200, feeRecipient
        );
    }

    function test_initialize_runsOnce_andStoresWhatItWasGiven() public {
        (PositionVault vault, uint256 id) = _lockedV3();
        assertEq(vault.owner(), alice);
        assertEq(vault.pendingOwner(), address(0));
        assertEq(vault.manager(), address(v3));
        assertEq(vault.tokenId(), id);
        assertEq(vault.unlockAt(), block.timestamp + 30 days);
        assertEq(uint8(vault.kind()), uint8(PositionVault.Kind.V3));
        assertEq(vault.feeShareBps(), SHARE_BPS);
        assertEq(vault.feeRecipient(), feeRecipient);

        vm.expectRevert(Initializable.InvalidInitialization.selector);
        vault.initialize(bob, address(v3), id, uint64(block.timestamp + 1 days), PositionVault.Kind.V3, 0, payable(bob));
    }

    function _freshClone() internal returns (PositionVault) {
        return PositionVault(payable(Clones.clone(factory.positionVaultImpl())));
    }

    function test_initialize_rejectsZeroAddresses() public {
        uint64 at = uint64(block.timestamp + 1 days);
        PositionVault c = _freshClone();
        vm.expectRevert(PositionVault.ZeroAddress.selector);
        c.initialize(address(0), address(v3), 1, at, PositionVault.Kind.V3, 200, feeRecipient);
        vm.expectRevert(PositionVault.ZeroAddress.selector);
        c.initialize(alice, address(0), 1, at, PositionVault.Kind.V3, 200, feeRecipient);
        vm.expectRevert(PositionVault.ZeroAddress.selector);
        c.initialize(alice, address(v3), 1, at, PositionVault.Kind.V3, 200, payable(address(0)));
    }

    function test_initialize_rejectsAnUnlockTimeOutsideTheWindow() public {
        PositionVault c = _freshClone();
        uint64 max = uint64(block.timestamp + c.MAX_DURATION());
        uint64[3] memory bad = [uint64(block.timestamp), uint64(block.timestamp - 1), max + 1];
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(PositionVault.BadUnlockTime.selector);
            c.initialize(alice, address(v3), 1, bad[i], PositionVault.Kind.V3, 200, feeRecipient);
        }
        c.initialize(alice, address(v3), 1, max, PositionVault.Kind.V3, 200, feeRecipient);
        assertEq(c.unlockAt(), max);
    }

    /// Deviation: a share above 100% would make every split underflow, so `collect` would revert forever. The factory
    /// never passes one (it bounds the share), but anyone can initialise a clone of the implementation.
    function test_initialize_rejectsAFeeShareAboveTenThousandBps() public {
        uint64 at = uint64(block.timestamp + 1 days);
        PositionVault c = _freshClone();
        vm.expectRevert(PositionVault.BadFeeShare.selector);
        c.initialize(alice, address(v3), 1, at, PositionVault.Kind.V3, 10_001, feeRecipient);
        c.initialize(alice, address(v3), 1, at, PositionVault.Kind.V3, 10_000, feeRecipient);
        assertEq(c.feeShareBps(), 10_000);
    }

    // ---------------------------------------------------------------------
    // Receiving the position
    // ---------------------------------------------------------------------

    function test_lockPosition_movesTheNftIntoTheVault() public {
        (PositionVault vault, uint256 id) = _lockedV3();
        assertEq(v3.ownerOf(id), address(vault));
        assertTrue(factory.isVault(address(vault)));
        (PositionVault vault4, uint256 id4) = _lockedV4(address(tokenA), address(tokenB));
        assertEq(v4.ownerOf(id4), address(vault4));
    }

    /// Deviation: the vault takes only the position it was made for, from its own manager. Any other NFT sent to it
    /// with a safe transfer would be stuck for good (withdraw only sends `tokenId`), so it is refused.
    function test_onERC721Received_refusesAnyOtherNft() public {
        (PositionVault vault,) = _lockedV3();
        uint256 other = v3.mint(alice, address(tokenA), address(tokenB), 1);
        vm.prank(alice);
        vm.expectRevert(PositionVault.UnexpectedNft.selector);
        v3.safeTransferFrom(alice, address(vault), other);

        MockV3PositionManager elsewhere = new MockV3PositionManager();
        uint256 foreign = elsewhere.mint(alice, address(tokenA), address(tokenB), 1);
        vm.prank(alice);
        vm.expectRevert(PositionVault.UnexpectedNft.selector);
        elsewhere.safeTransferFrom(alice, address(vault), foreign);

        // And a direct call claiming to deliver it proves nothing either.
        uint256 own = vault.tokenId();
        vm.expectRevert(PositionVault.UnexpectedNft.selector);
        vault.onERC721Received(alice, alice, own, "");
    }

    /// `liquidity()` is the position's live liquidity, read from its manager on every call, for Inspector.
    function test_liquidity_isTheLiveLiquidityFromTheManager() public {
        (PositionVault a, uint256 id) = _lockedV3();
        assertEq(a.liquidity(), LIQUIDITY);
        (PositionVault b,) = _lockedV4(NATIVE, address(tokenB));
        assertEq(b.liquidity(), LIQUIDITY);
        vm.warp(a.unlockAt());
        vm.prank(alice);
        a.withdraw(alice);
        vm.prank(alice);
        v3.decreaseLiquidity(MockV3PositionManager.DecreaseLiquidityParams(id, 1, 0, 0, block.timestamp));
        assertEq(a.liquidity(), LIQUIDITY - 1);
    }

    function test_currencies_areThePoolsTwoCurrencies() public {
        (PositionVault a,) = _lockedV3();
        (address c0, address c1) = a.currencies();
        assertEq(c0, address(tokenA));
        assertEq(c1, address(tokenB));
        (PositionVault b,) = _lockedV4(NATIVE, address(tokenB));
        (c0, c1) = b.currencies();
        assertEq(c0, NATIVE);
        assertEq(c1, address(tokenB));
    }

    // ---------------------------------------------------------------------
    // collect: the split
    // ---------------------------------------------------------------------

    function test_collect_v3_splitsByTheShare_andLeavesThePrincipal() public {
        (PositionVault vault, uint256 id) = _lockedV3();
        v3.accrue(id, 1000 ether, 50 ether);

        vm.expectEmit(true, false, false, true, address(vault));
        emit PositionVault.Collected(address(tokenA), 980 ether, 20 ether);
        vm.expectEmit(true, false, false, true, address(vault));
        emit PositionVault.Collected(address(tokenB), 49 ether, 1 ether);
        vm.prank(alice);
        vault.collect();

        assertEq(tokenA.balanceOf(alice), 980 ether);
        assertEq(tokenA.balanceOf(feeRecipient), 20 ether);
        assertEq(tokenB.balanceOf(alice), 49 ether);
        assertEq(tokenB.balanceOf(feeRecipient), 1 ether);
        assertEq(tokenA.balanceOf(address(vault)), 0);
        assertEq(tokenB.balanceOf(address(vault)), 0);
        assertEq(v3.liquidityOf(id), LIQUIDITY, "principal moved");
        assertEq(v3.ownerOf(id), address(vault));
    }

    function test_collect_v4_erc20_splitsByTheShare_andDecreasesByZero() public {
        (PositionVault vault, uint256 id) = _lockedV4(address(tokenA), address(tokenB));
        _accrueV4(id, address(tokenA), 500 ether, 7 ether);
        vm.prank(alice);
        vault.collect();
        assertEq(tokenA.balanceOf(alice), 490 ether);
        assertEq(tokenA.balanceOf(feeRecipient), 10 ether);
        assertEq(tokenB.balanceOf(alice), 6.86 ether);
        assertEq(tokenB.balanceOf(feeRecipient), 0.14 ether);
        assertEq(v4.getPositionLiquidity(id), LIQUIDITY, "principal moved");
        assertEq(v4.decreaseCalls(), 1);
    }

    function test_collect_v4_native_splitsNativeValue() public {
        (PositionVault vault, uint256 id) = _lockedV4(NATIVE, address(tokenB));
        _accrueV4(id, NATIVE, 100 ether, 3 ether);
        uint256 aliceBefore = alice.balance;
        uint256 feeBefore = feeRecipient.balance;
        vm.expectEmit(true, false, false, true, address(vault));
        emit PositionVault.Collected(NATIVE, 98 ether, 2 ether);
        vm.prank(alice);
        vault.collect();
        assertEq(alice.balance - aliceBefore, 98 ether);
        assertEq(feeRecipient.balance - feeBefore, 2 ether);
        assertEq(tokenB.balanceOf(alice), 2.94 ether);
        assertEq(address(vault).balance, 0);
        assertEq(v4.getPositionLiquidity(id), LIQUIDITY);
    }

    function test_collect_withNothingAccrued_movesNothing_andEmitsNothing() public {
        (PositionVault vault,) = _lockedV3();
        vm.recordLogs();
        vm.prank(alice);
        vault.collect();
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(tokenA.balanceOf(alice), 0);
    }

    /// The platform's share rounds down: it never takes more than the stated rate.
    function test_collect_platformShareRoundsDown() public {
        (PositionVault vault, uint256 id) = _lockedV3();
        v3.accrue(id, 49, 50); // 49 * 200 / 10,000 = 0.98 -> 0; 50 -> 1
        vm.prank(alice);
        vault.collect();
        assertEq(tokenA.balanceOf(alice), 49);
        assertEq(tokenA.balanceOf(feeRecipient), 0);
        assertEq(tokenB.balanceOf(alice), 49);
        assertEq(tokenB.balanceOf(feeRecipient), 1);
    }

    /// The share is the one copied at creation: a later fee change, a new recipient, or a manager being disallowed
    /// never reaches an existing vault.
    function test_collect_usesTheShareAndRecipientCopiedAtCreation() public {
        (PositionVault vault, uint256 id) = _lockedV3();
        vm.startPrank(feeOwner);
        fees.setFee(KEY_SHARE, 0);
        fees.setRecipient(payable(bob));
        vm.stopPrank();
        vm.prank(factoryOwner);
        factory.setManager(address(v3), false, PositionVault.Kind.V4);

        v3.accrue(id, 100 ether, 100 ether);
        vm.prank(alice);
        vault.collect();
        assertEq(tokenA.balanceOf(feeRecipient), 2 ether);
        assertEq(tokenA.balanceOf(bob), 0);
        assertEq(tokenA.balanceOf(alice), 98 ether);
    }

    function test_collect_atTheShareBounds_zeroAndAll() public {
        for (uint256 share = 0; share <= BPS; share += BPS) {
            PositionVault c = _freshClone();
            uint256 id = v3.mint(address(this), address(tokenA), address(tokenB), LIQUIDITY);
            c.initialize(
                alice,
                address(v3),
                id,
                uint64(block.timestamp + 1 days),
                PositionVault.Kind.V3,
                SafeCast.toUint16(share),
                feeRecipient
            );
            v3.safeTransferFrom(address(this), address(c), id);
            v3.accrue(id, 1000, 1000);
            uint256 aliceBefore = tokenA.balanceOf(alice);
            uint256 feeBefore = tokenA.balanceOf(feeRecipient);
            vm.prank(alice);
            c.collect();
            assertEq(tokenA.balanceOf(feeRecipient) - feeBefore, share == 0 ? 0 : 1000);
            assertEq(tokenA.balanceOf(alice) - aliceBefore, share == 0 ? 1000 : 0);
        }
    }

    function test_collect_isOwnerOnly() public {
        (PositionVault vault, uint256 id) = _lockedV3();
        v3.accrue(id, 1 ether, 1 ether);
        address[4] memory others = [stranger, bob, address(feeRecipient), factoryOwner];
        vm.prank(alice);
        vault.transferOwnership(bob); // a pending owner has no power yet
        for (uint256 i; i < others.length; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(PositionVault.NotOwner.selector);
            vault.collect();
        }
        vm.prank(address(factory));
        vm.expectRevert(PositionVault.NotOwner.selector);
        vault.collect();
    }

    function test_collect_keepsWorkingAfterTheUnlockTime_untilWithdraw() public {
        (PositionVault vault, uint256 id) = _lockedV3();
        vm.warp(vault.unlockAt() + 365 days);
        v3.accrue(id, 100, 100);
        vm.prank(alice);
        vault.collect();
        assertEq(tokenA.balanceOf(alice), 98);

        vm.prank(alice);
        vault.withdraw(alice);
        vm.prank(alice);
        vm.expectRevert(MockV3PositionManager.NotApproved.selector); // the vault no longer holds the position
        vault.collect();
    }

    function test_collect_isNotReentrant() public {
        ReenteringOwner o = new ReenteringOwner();
        (PositionVault vault, uint256 id) = _lockedV4(NATIVE, address(tokenB));
        o.setVault(vault);
        vm.prank(alice);
        vault.transferOwnership(address(o));
        o.acceptOwnership();
        _accrueV4(id, NATIVE, 10 ether, 0);
        o.collect();
        assertEq(bytes4(o.seen()), ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        assertEq(address(o).balance, 9.8 ether);
    }

    /// An owner that cannot receive native value cannot collect it: the value stays in the vault for a later collect
    /// by an owner that can, rather than being lost or paid elsewhere.
    function test_collect_revertsWhenTheOwnerCannotReceiveNativeValue() public {
        NativeRefusingOwner o = new NativeRefusingOwner();
        (PositionVault vault, uint256 id) = _lockedV4(NATIVE, address(tokenB));
        o.setVault(vault);
        vm.prank(alice);
        vault.transferOwnership(address(o));
        o.acceptOwnership();
        _accrueV4(id, NATIVE, 10 ether, 0);
        uint256 recipientBefore = feeRecipient.balance;
        vm.expectRevert(PositionVault.NativeTransferFailed.selector);
        o.collect();
        assertEq(feeRecipient.balance, recipientBefore);
    }

    /// withdraw is guarded too: an owner contract cannot re-enter the vault from the NFT transfer withdraw makes.
    function test_withdraw_isNotReentrant() public {
        ReenteringNftOwner o = new ReenteringNftOwner();
        (PositionVault vault, uint256 id) = _lockedV3();
        o.setVault(vault);
        vm.prank(alice);
        vault.transferOwnership(address(o));
        o.acceptOwnership();
        vm.warp(vault.unlockAt());
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        o.withdraw();
        assertEq(v3.ownerOf(id), address(vault));
    }

    /// Tokens or value that reach the vault by other means leave with the next collect, split like fees. The vault can
    /// not tell them apart from fees, and it holds nothing else of those currencies.
    function test_collect_sweepsWhateverTheVaultHoldsOfThePoolsCurrencies() public {
        (PositionVault vault,) = _lockedV4(NATIVE, address(tokenB));
        tokenB.mint(address(vault), 100);
        vm.deal(address(this), 100);
        (bool ok,) = address(vault).call{value: 100}("");
        assertTrue(ok);
        // Nothing accrued, so the zero decrease has nothing to credit; the vault's own balances still split.
        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        vault.collect();
        assertEq(alice.balance - aliceBefore, 98);
        assertEq(tokenB.balanceOf(alice), 98);
    }

    // ---------------------------------------------------------------------
    // collect: a fee recipient that cannot be paid (Q9, decided: skip the platform's share)
    // ---------------------------------------------------------------------

    /// A vault whose fee recipient is `r`, locked while `r` accepted payments (it is paid the flat fee then).
    function _vaultWithRecipient(address payable r, bool native) internal returns (PositionVault vault, uint256 id) {
        vm.prank(feeOwner);
        fees.setRecipient(r);
        (vault, id) = native ? _lockedV4(NATIVE, address(tokenB)) : _lockedV4(address(tokenA), address(tokenB));
        assertEq(vault.feeRecipient(), r);
    }

    function _assertSkippedNative(PositionVault vault, uint256 id, MockSwitchableReceiver r) internal {
        _accrueV4(id, NATIVE, 100 ether, 0);
        uint256 aliceBefore = alice.balance;
        uint256 rBefore = address(r).balance;
        vm.expectEmit(true, false, false, true, address(vault));
        emit PositionVault.PlatformShareSkipped(NATIVE, 2 ether);
        vm.expectEmit(true, false, false, true, address(vault));
        emit PositionVault.Collected(NATIVE, 100 ether, 0);
        vm.prank(alice);
        uint256 g = gasleft();
        vault.collect{gas: 2_000_000}();
        uint256 used = g - gasleft();
        assertEq(alice.balance - aliceBefore, 100 ether, "the owner gets the whole amount");
        assertEq(address(r).balance, rBefore, "the recipient got something");
        assertEq(address(vault).balance, 0);
        // A hostile recipient costs the owner at most the bounded call, however much it burns or returns.
        assertLt(used, 300_000, "collect was griefed");
    }

    function test_q9_native_recipientThatReverts_isSkipped() public {
        MockSwitchableReceiver r = new MockSwitchableReceiver();
        (PositionVault vault, uint256 id) = _vaultWithRecipient(payable(address(r)), true);
        r.setMode(MockSwitchableReceiver.Mode.Revert);
        _assertSkippedNative(vault, id, r);
    }

    function test_q9_native_recipientThatBurnsAllGas_isSkipped_atABoundedCost() public {
        MockSwitchableReceiver r = new MockSwitchableReceiver();
        (PositionVault vault, uint256 id) = _vaultWithRecipient(payable(address(r)), true);
        r.setMode(MockSwitchableReceiver.Mode.BurnGas);
        _assertSkippedNative(vault, id, r);
    }

    function test_q9_native_recipientThatReturnsAMegabyte_isSkipped_atABoundedCost() public {
        MockSwitchableReceiver r = new MockSwitchableReceiver();
        (PositionVault vault, uint256 id) = _vaultWithRecipient(payable(address(r)), true);
        r.setMode(MockSwitchableReceiver.Mode.ReturnBomb);
        _assertSkippedNative(vault, id, r);
    }

    /// A contract recipient that needs more than the 2,300 gas stipend (a multisig) is paid normally.
    function test_q9_native_healthyContractRecipient_isPaid() public {
        MockSwitchableReceiver r = new MockSwitchableReceiver();
        (PositionVault vault, uint256 id) = _vaultWithRecipient(payable(address(r)), true);
        _accrueV4(id, NATIVE, 100 ether, 0);
        uint256 before = r.received();
        vm.prank(alice);
        vault.collect();
        assertEq(r.received() - before, 2 ether);
    }

    function _hostileVault(MockHostileToken.Mode mode) internal returns (PositionVault vault, MockHostileToken t) {
        t = new MockHostileToken();
        uint256 id = _mintV4(alice, address(t), address(tokenB));
        vault = _lockPosition(alice, address(v4), id, 30 days, alice);
        t.setMode(feeRecipient, mode);
        _accrueV4(id, address(t), 100 ether, 100 ether);
    }

    function _assertSkippedToken(MockHostileToken.Mode mode) internal {
        (PositionVault vault, MockHostileToken t) = _hostileVault(mode);
        vm.expectEmit(true, false, false, true, address(vault));
        emit PositionVault.PlatformShareSkipped(address(t), 2 ether);
        vm.expectEmit(true, false, false, true, address(vault));
        emit PositionVault.Collected(address(t), 100 ether, 0);
        vm.prank(alice);
        uint256 g = gasleft();
        vault.collect{gas: 2_000_000}();
        uint256 used = g - gasleft();
        assertEq(t.balanceOf(alice), 100 ether, "the owner gets the whole amount");
        assertEq(t.balanceOf(feeRecipient), 0);
        assertEq(t.balanceOf(address(vault)), 0);
        // The other currency is unaffected: its share is paid.
        assertEq(tokenB.balanceOf(feeRecipient), 2 ether);
        assertEq(tokenB.balanceOf(alice), 98 ether);
        assertLt(used, 450_000, "collect was griefed");
    }

    function test_q9_token_thatRevertsForTheRecipient_isSkipped() public {
        _assertSkippedToken(MockHostileToken.Mode.Revert);
    }

    function test_q9_token_thatReturnsFalseForTheRecipient_isSkipped() public {
        _assertSkippedToken(MockHostileToken.Mode.ReturnFalse);
    }

    function test_q9_token_thatBurnsAllGasForTheRecipient_isSkipped_atABoundedCost() public {
        _assertSkippedToken(MockHostileToken.Mode.BurnGas);
    }

    function test_q9_token_thatRevertsWithAMegabyte_isSkipped_atABoundedCost() public {
        _assertSkippedToken(MockHostileToken.Mode.ReturnBomb);
    }

    /// A token that returns nothing from `transfer` (like USDT on Ethereum) still pays the platform.
    function test_q9_token_thatReturnsNothing_stillPaysThePlatform() public {
        (PositionVault vault, MockHostileToken t) = _hostileVault(MockHostileToken.Mode.ReturnNothing);
        vm.prank(alice);
        vault.collect();
        assertEq(t.balanceOf(feeRecipient), 2 ether);
        assertEq(t.balanceOf(alice), 98 ether);
    }

    /// The skip is decided per collect: a recipient that recovers is paid again next time.
    function test_q9_aRecipientThatRecovers_isPaidAgain() public {
        MockSwitchableReceiver r = new MockSwitchableReceiver();
        (PositionVault vault, uint256 id) = _vaultWithRecipient(payable(address(r)), true);
        r.setMode(MockSwitchableReceiver.Mode.Revert);
        _accrueV4(id, NATIVE, 100 ether, 0);
        vm.prank(alice);
        vault.collect();
        r.setMode(MockSwitchableReceiver.Mode.Accept);
        uint256 before = r.received();
        _accrueV4(id, NATIVE, 100 ether, 0);
        vm.prank(alice);
        vault.collect();
        assertEq(r.received() - before, 2 ether);
    }

    /// A share that rounds down to zero is not paid at all, so it is never "skipped" either, even for a recipient
    /// that cannot receive.
    function test_q9_aShareThatRoundsToZero_isNeitherPaidNorSkipped() public {
        MockSwitchableReceiver r = new MockSwitchableReceiver();
        (PositionVault vault, uint256 id) = _vaultWithRecipient(payable(address(r)), true);
        r.setMode(MockSwitchableReceiver.Mode.Revert);
        _accrueV4(id, NATIVE, 49, 0); // 49 * 200 / 10,000 rounds down to 0
        uint256 aliceBefore = alice.balance;
        vm.recordLogs();
        vm.prank(alice);
        vault.collect();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != PositionVault.PlatformShareSkipped.selector, "a zero share was skipped");
        }
        assertEq(alice.balance - aliceBefore, 49);
    }

    /// The same for a recipient that needs most of the budget: the vault must reserve the call's own costs on top of
    /// the forwarded gas, or a gas limit just above the bare budget would forward too little and skip it.
    function test_q9_theOwnerCannotStarveARecipientThatNeedsMostOfTheBudget() public {
        MockSwitchableReceiver r = new MockSwitchableReceiver();
        (PositionVault vault, uint256 id) = _vaultWithRecipient(payable(address(r)), true);
        r.setMode(MockSwitchableReceiver.Mode.Heavy);
        _accrueV4(id, NATIVE, 100 ether, 0);
        _sweepGasLimits(vault, NATIVE, address(r), 2 ether);
    }

    /// Deviation (part of Q9): the owner cannot keep the platform's share by sending `collect` with just too little
    /// gas for the platform's payment. The vault checks that the whole bounded amount is available before trying, so
    /// a healthy recipient either is paid or the whole call reverts; it is never skipped.
    function test_q9_theOwnerCannotStarveAHealthyRecipient_native() public {
        MockSwitchableReceiver r = new MockSwitchableReceiver();
        (PositionVault vault, uint256 id) = _vaultWithRecipient(payable(address(r)), true);
        _accrueV4(id, NATIVE, 100 ether, 0);
        _sweepGasLimits(vault, NATIVE, address(r), 2 ether);
    }

    function test_q9_theOwnerCannotStarveAHealthyRecipient_token() public {
        (PositionVault vault, MockHostileToken t) = _hostileVault(MockHostileToken.Mode.None);
        _sweepGasLimits(vault, address(t), feeRecipient, 2 ether);
    }

    function _balance(address currency, address who) internal view returns (uint256) {
        return currency == NATIVE ? who.balance : MockToken(currency).balanceOf(who);
    }

    /// Calls collect with every gas limit from 30,000 to 800,000 in steps of 500. Each call either pays the recipient
    /// its exact share (a skip would leave its balance unchanged), or reverts; a revert with too little gas for the
    /// whole bounded payment is `InsufficientGas`, decided before the payment is tried. The state is restored after
    /// each call.
    function _sweepGasLimits(PositionVault vault, address currency, address recipient, uint256 share) internal {
        uint256 paid;
        uint256 refused;
        for (uint256 limit = 30_000; limit <= 800_000; limit += 500) {
            uint256 snap = vm.snapshotState();
            uint256 before = _balance(currency, recipient);
            vm.prank(alice);
            (bool ok, bytes memory ret) = address(vault).call{gas: limit}(abi.encodeCall(PositionVault.collect, ()));
            if (ok) {
                ++paid;
                assertEq(_balance(currency, recipient) - before, share, "a healthy recipient was skipped");
            } else if (keccak256(ret) == keccak256(abi.encodeWithSelector(PositionVault.InsufficientGas.selector))) {
                ++refused;
            }
            vm.revertToState(snap);
        }
        assertGt(paid, 0, "no gas limit was enough: the sweep is vacuous");
        assertGt(refused, 0, "no call was refused for too little gas");
    }

    // ---------------------------------------------------------------------
    // extend, withdraw, ownership
    // ---------------------------------------------------------------------

    function test_extend_onlyLengthens_withinTheWindow_ownerOnly() public {
        (PositionVault vault,) = _lockedV3();
        uint64 at = vault.unlockAt();
        uint64 tooFar = uint64(block.timestamp + vault.MAX_DURATION() + 1);
        vm.startPrank(alice);
        vm.expectRevert(PositionVault.BadUnlockTime.selector);
        vault.extend(at);
        vm.expectRevert(PositionVault.BadUnlockTime.selector);
        vault.extend(at - 1);
        vm.expectRevert(PositionVault.BadUnlockTime.selector);
        vault.extend(tooFar);
        vm.expectEmit(false, false, false, true, address(vault));
        emit PositionVault.Extended(at + 1);
        vault.extend(at + 1);
        vm.stopPrank();
        assertEq(vault.unlockAt(), at + 1);

        vm.prank(stranger);
        vm.expectRevert(PositionVault.NotOwner.selector);
        vault.extend(at + 2);
    }

    /// Deviation, as in LockVault (D1): on an expired lock, a "later" time that is already in the past is refused.
    function test_extend_afterExpiry_canRelock_butNotIntoThePast() public {
        (PositionVault vault,) = _lockedV3();
        uint64 at = vault.unlockAt();
        vm.warp(at + 10 days);
        vm.prank(alice);
        vm.expectRevert(PositionVault.BadUnlockTime.selector);
        vault.extend(at + 1 days);
        vm.prank(alice);
        vm.expectRevert(PositionVault.BadUnlockTime.selector);
        vault.extend(uint64(block.timestamp));
        vm.prank(alice);
        vault.extend(uint64(block.timestamp + 1));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PositionVault.StillLocked.selector, uint64(block.timestamp + 1)));
        vault.withdraw(alice);
    }

    function test_withdraw_oneSecondBefore_reverts_atUnlock_sendsThePosition() public {
        (PositionVault vault, uint256 id) = _lockedV3();
        uint64 at = vault.unlockAt();
        vm.warp(at - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PositionVault.StillLocked.selector, at));
        vault.withdraw(alice);

        vm.warp(at);
        vm.expectEmit(true, false, false, true, address(vault));
        emit PositionVault.Withdrawn(bob);
        vm.prank(alice);
        vault.withdraw(bob);
        assertEq(v3.ownerOf(id), bob);
        assertEq(v3.liquidityOf(id), LIQUIDITY);
    }

    function test_withdraw_v4_sendsThePosition() public {
        (PositionVault vault, uint256 id) = _lockedV4(NATIVE, address(tokenB));
        vm.warp(vault.unlockAt());
        vm.prank(alice);
        vault.withdraw(alice);
        assertEq(v4.ownerOf(id), alice);
    }

    function test_withdraw_isOwnerOnly_andRefusesZero() public {
        (PositionVault vault, uint256 id) = _lockedV3();
        vm.warp(vault.unlockAt());
        vm.prank(stranger);
        vm.expectRevert(PositionVault.NotOwner.selector);
        vault.withdraw(stranger);
        vm.prank(address(feeRecipient));
        vm.expectRevert(PositionVault.NotOwner.selector);
        vault.withdraw(address(feeRecipient));
        vm.prank(alice);
        vm.expectRevert(PositionVault.ZeroAddress.selector);
        vault.withdraw(address(0));
        assertEq(v3.ownerOf(id), address(vault));
    }

    function test_ownership_isTwoStep() public {
        (PositionVault vault, uint256 id) = _lockedV3();
        vm.prank(stranger);
        vm.expectRevert(PositionVault.NotOwner.selector);
        vault.transferOwnership(stranger);

        vm.expectEmit(true, true, false, false, address(vault));
        emit PositionVault.OwnershipTransferStarted(alice, bob);
        vm.prank(alice);
        vault.transferOwnership(bob);
        assertEq(vault.owner(), alice);
        assertEq(vault.pendingOwner(), bob);

        vm.prank(stranger);
        vm.expectRevert(PositionVault.NotPendingOwner.selector);
        vault.acceptOwnership();

        vm.expectEmit(true, true, false, false, address(vault));
        emit PositionVault.OwnershipTransferred(alice, bob);
        vm.prank(bob);
        vault.acceptOwnership();
        assertEq(vault.owner(), bob);
        assertEq(vault.pendingOwner(), address(0));

        v3.accrue(id, 100, 100);
        vm.prank(alice);
        vm.expectRevert(PositionVault.NotOwner.selector);
        vault.collect();
        vm.prank(bob);
        vault.collect();
        assertEq(tokenA.balanceOf(bob), 98);
    }

    function test_transferOwnership_toZero_cancels() public {
        (PositionVault vault,) = _lockedV3();
        vm.startPrank(alice);
        vault.transferOwnership(bob);
        vault.transferOwnership(address(0));
        vm.stopPrank();
        vm.prank(bob);
        vm.expectRevert(PositionVault.NotPendingOwner.selector);
        vault.acceptOwnership();
    }

    // ---------------------------------------------------------------------
    // Nobody else can take the position out, before or after the unlock time
    // ---------------------------------------------------------------------

    function test_theManagerRefusesEveryoneButTheVault() public {
        (PositionVault vault, uint256 id) = _lockedV3();
        address[3] memory others = [alice, stranger, address(factory)];
        for (uint256 i; i < others.length; ++i) {
            vm.startPrank(others[i]);
            vm.expectRevert();
            v3.transferFrom(address(vault), others[i], id);
            vm.expectRevert();
            v3.approve(others[i], id);
            vm.expectRevert(MockV3PositionManager.NotApproved.selector);
            v3.decreaseLiquidity(MockV3PositionManager.DecreaseLiquidityParams(id, 1, 0, 0, block.timestamp));
            vm.expectRevert(MockV3PositionManager.NotApproved.selector);
            v3.collect(MockV3PositionManager.CollectParams(id, others[i], type(uint128).max, type(uint128).max));
            vm.stopPrank();
        }
        assertEq(v3.ownerOf(id), address(vault));
        assertEq(v3.getApproved(id), address(0));
        assertFalse(v3.isApprovedForAll(address(vault), alice));
    }

    /// An approval given before the lock does not survive the move into the vault.
    function test_anApprovalGivenBeforeTheLock_doesNotSurvive() public {
        uint256 id = v3.mint(alice, address(tokenA), address(tokenB), LIQUIDITY);
        vm.startPrank(alice);
        v3.setApprovalForAll(bob, true);
        v3.approve(address(factory), id);
        vm.stopPrank();
        PositionVault vault = _lockPosition(alice, address(v3), id, 30 days, alice);
        assertEq(v3.getApproved(id), address(0));
        vm.prank(bob);
        vm.expectRevert(MockV3PositionManager.NotApproved.selector);
        v3.decreaseLiquidity(MockV3PositionManager.DecreaseLiquidityParams(id, 1, 0, 0, block.timestamp));
        assertEq(v3.ownerOf(id), address(vault));
    }

    function test_theVaultAcceptsNativeValue() public {
        (PositionVault vault,) = _lockedV4(NATIVE, address(tokenB));
        vm.deal(stranger, 1);
        vm.prank(stranger);
        (bool ok,) = address(vault).call{value: 1}("");
        assertTrue(ok);
    }
}
