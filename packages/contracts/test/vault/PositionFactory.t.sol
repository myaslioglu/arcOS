// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {PositionVault} from "../../src/vault/PositionVault.sol";
import {VaultFactory} from "../../src/vault/VaultFactory.sol";
import {PositionTestBase} from "./PositionTestBase.sol";
import {MockV3ManagerThatKeepsTheNft, MockV3PositionManager} from "./mocks/PositionMocks.sol";

/// `VaultFactory.lockPosition` with the real PositionVault: the NFT moves into a new vault in the same call, and the
/// vault is registered under its owner and under both of its pool's currencies.
contract PositionFactoryTest is PositionTestBase {
    /// Slot of `VaultFactory._positionVaultsForToken` (`forge inspect VaultFactory storage-layout`), as
    /// VaultRegistry.t.sol seeds it.
    uint256 internal constant POSITION_REGISTRY_SLOT = 6;

    function _registered(address currency, address vault) internal view returns (bool) {
        address[] memory all = factory.positionVaultsForToken(currency);
        for (uint256 i; i < all.length; ++i) {
            if (all[i] == vault) return true;
        }
        return false;
    }

    function test_lockPosition_v3_registersUnderTheOwnerAndBothCurrencies() public {
        uint256 id = _mintV3(alice);
        uint256 recipientBefore = feeRecipient.balance;
        address predicted = vm.computeCreateAddress(address(factory), vm.getNonce(address(factory)));
        uint64 at = uint64(block.timestamp + 30 days);

        vm.expectEmit(true, true, true, true, address(factory));
        emit VaultFactory.PositionLocked(bob, address(v3), id, predicted, at);
        vm.prank(alice);
        address vault = factory.lockPosition{value: FLAT}(address(v3), id, at, bob);

        assertEq(vault, predicted);
        assertEq(v3.ownerOf(id), vault, "the NFT moved in the same call");
        assertTrue(factory.isVault(vault));
        assertEq(PositionVault(payable(vault)).owner(), bob);
        address[] memory ofBob = factory.vaultsOf(bob);
        assertEq(ofBob.length, 1);
        assertEq(ofBob[0], vault);
        assertEq(factory.positionVaultsForTokenLength(address(tokenA)), 1);
        assertEq(factory.positionVaultsForTokenLength(address(tokenB)), 1);
        assertTrue(_registered(address(tokenA), vault));
        assertTrue(_registered(address(tokenB), vault));
        assertEq(factory.vaultsForTokenLength(address(tokenA)), 0, "position locks stay out of the ERC-20 registry");
        assertEq(feeRecipient.balance - recipientBefore, FLAT);
        assertEq(address(factory).balance, 0);
    }

    function test_lockPosition_v4Native_registersUnderAddressZero() public {
        (PositionVault vault,) = _lockedV4(NATIVE, address(tokenB));
        assertTrue(_registered(NATIVE, address(vault)));
        assertTrue(_registered(address(tokenB), address(vault)));
        assertEq(factory.positionVaultsForTokenLength(NATIVE), 1);
        assertEq(factory.positionVaultsForTokenLength(address(tokenB)), 1);
    }

    function test_lockPosition_registriesGrowInCreationOrder() public {
        (PositionVault a,) = _lockedV3();
        (PositionVault b,) = _lockedV4(address(tokenA), address(tokenB));
        (PositionVault c,) = _lockedV4(NATIVE, address(tokenA));
        address[] memory forA = factory.positionVaultsForTokenSlice(address(tokenA), 0, 10);
        assertEq(forA.length, 3);
        assertEq(forA[0], address(a));
        assertEq(forA[1], address(b));
        assertEq(forA[2], address(c));
        assertEq(factory.positionVaultsForTokenLength(address(tokenB)), 2);
        assertEq(factory.vaultsOfLength(alice), 3);
    }

    /// Hand-off item 5: the registry tests seed slot 6 directly. Real locks must write exactly there, so the seeding
    /// stays honest: the raw length and entries at slot 6 equal what the getters return after real locks.
    function test_canary_realLocksWriteThePositionRegistryAtTheSeededSlot() public {
        (PositionVault a,) = _lockedV3();
        (PositionVault b,) = _lockedV3();
        bytes32 lengthSlot = keccak256(abi.encode(address(tokenA), POSITION_REGISTRY_SLOT));
        assertEq(uint256(vm.load(address(factory), lengthSlot)), 2, "position registry slot moved");
        uint256 base = uint256(keccak256(abi.encode(lengthSlot)));
        assertEq(address(uint160(uint256(vm.load(address(factory), bytes32(base))))), address(a));
        assertEq(address(uint160(uint256(vm.load(address(factory), bytes32(base + 1))))), address(b));
    }

    /// No real pool pairs a currency with itself, but a vault must never be listed twice under one key.
    function test_lockPosition_aPositionWithTheSameCurrencyTwice_isRegisteredOnce() public {
        (PositionVault vault,) = _lockedV4(address(tokenA), address(tokenA));
        address[] memory forA = factory.positionVaultsForToken(address(tokenA));
        assertEq(forA.length, 1);
        assertEq(forA[0], address(vault));
    }

    function test_lockPosition_withoutApproval_revertsAndLeavesNothing() public {
        uint256 id = v3.mint(alice, address(tokenA), address(tokenB), LIQUIDITY);
        Snap memory s = _snap(alice, address(tokenA));
        uint64 at = uint64(block.timestamp + 30 days);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InsufficientApproval.selector, address(factory), id));
        factory.lockPosition{value: FLAT}(address(v3), id, at, alice);
        _assertNothingLeftBehind(s, alice, address(tokenA));
        assertEq(factory.positionVaultsForTokenLength(address(tokenA)), 0);
        assertEq(v3.ownerOf(id), alice);
    }

    /// The NFT always comes from the caller: approving the factory for a position does not let anyone else lock it.
    function test_lockPosition_cannotLockSomeoneElsesPosition_evenIfTheFactoryIsApproved() public {
        uint256 id = _mintV3(bob); // bob approves the factory for his position
        uint64 at = uint64(block.timestamp + 3650 days);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721IncorrectOwner.selector, alice, id, bob));
        factory.lockPosition{value: FLAT}(address(v3), id, at, alice);
        assertEq(v3.ownerOf(id), bob);

        uint256 id4 = _mintV4(bob, NATIVE, address(tokenB));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721IncorrectOwner.selector, alice, id4, bob));
        factory.lockPosition{value: FLAT}(address(v4), id4, at, alice);
        assertEq(v4.ownerOf(id4), bob);
    }

    function test_lockPosition_revertsForAPositionThatDoesNotExist() public {
        uint64 at = uint64(block.timestamp + 30 days);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 999));
        factory.lockPosition{value: FLAT}(address(v3), 999, at, alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 999));
        factory.lockPosition{value: FLAT}(address(v4), 999, at, alice);
    }

    function test_lockPosition_checksTheFlatFee_andTheUnlockTime() public {
        uint256 id = _mintV3(alice);
        uint64 at = uint64(block.timestamp + 30 days);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(VaultFactory.WrongFee.selector, FLAT, FLAT - 1));
        factory.lockPosition{value: FLAT - 1}(address(v3), id, at, alice);
        vm.prank(alice);
        vm.expectRevert(PositionVault.BadUnlockTime.selector);
        factory.lockPosition{value: FLAT}(address(v3), id, uint64(block.timestamp), alice);
        vm.prank(alice);
        vm.expectRevert(PositionVault.ZeroAddress.selector);
        factory.lockPosition{value: FLAT}(address(v3), id, at, address(0));
    }

    // ---------------------------------------------------------------------
    // A lock must hold principal (review I1) and must hold the NFT itself (M7)
    // ---------------------------------------------------------------------

    /// A position with no liquidity has no principal to lock: an Inspector reading "locked" for it would be a lie, and
    /// on v4 every collect would revert. Refused on both managers, and nothing is left behind.
    function test_lockPosition_refusesAPositionWithNoLiquidity() public {
        uint64 at = uint64(block.timestamp + 30 days);
        uint256 id3 = v3.mint(alice, address(tokenA), address(tokenB), 0);
        uint256 id4 = v4.mint(alice, NATIVE, address(tokenB), 0);
        vm.startPrank(alice);
        v3.approve(address(factory), id3);
        v4.approve(address(factory), id4);
        vm.expectRevert(VaultFactory.NoLiquidity.selector);
        factory.lockPosition{value: FLAT}(address(v3), id3, at, alice);
        vm.expectRevert(VaultFactory.NoLiquidity.selector);
        factory.lockPosition{value: FLAT}(address(v4), id4, at, alice);
        vm.stopPrank();
        assertEq(v3.ownerOf(id3), alice);
        assertEq(v4.ownerOf(id4), alice);
        assertEq(factory.vaultsOfLength(alice), 0);
        assertEq(factory.positionVaultsForTokenLength(address(tokenB)), 0);
    }

    /// On v3, decreasing liquidity moves principal into `tokensOwed`, where the first collect would release it as if it
    /// were fees. A position with anything owed is refused until it is collected; then it locks.
    function test_lockPosition_v3_refusesPrincipalWaitingInTokensOwed_untilCollected() public {
        uint256 id = _mintV3(alice);
        uint64 at = uint64(block.timestamp + 30 days);
        vm.startPrank(alice);
        v3.decreaseLiquidity(MockV3PositionManager.DecreaseLiquidityParams(id, LIQUIDITY / 2, 0, 0, block.timestamp));
        vm.expectRevert(VaultFactory.OwedNotCollected.selector);
        factory.lockPosition{value: FLAT}(address(v3), id, at, alice);
        assertEq(v3.ownerOf(id), alice);

        v3.collect(MockV3PositionManager.CollectParams(id, alice, type(uint128).max, type(uint128).max));
        PositionVault vault = PositionVault(payable(factory.lockPosition{value: FLAT}(address(v3), id, at, alice)));
        vm.stopPrank();
        assertEq(v3.ownerOf(id), address(vault));
        assertEq(vault.liquidity(), LIQUIDITY - LIQUIDITY / 2);
    }

    /// Fees waiting in `tokensOwed` cannot be told apart from principal, so they are refused the same way: one owed
    /// side is enough.
    function test_lockPosition_v3_refusesAnythingOwed_onEitherSide() public {
        uint64 at = uint64(block.timestamp + 30 days);
        for (uint256 side; side < 2; ++side) {
            uint256 id = _mintV3(alice);
            v3.accrue(id, side == 0 ? 1 : 0, side == 1 ? 1 : 0);
            vm.prank(alice);
            vm.expectRevert(VaultFactory.OwedNotCollected.selector);
            factory.lockPosition{value: FLAT}(address(v3), id, at, alice);
        }
    }

    /// A v3 position emptied and collected has nothing left: refused as having no liquidity.
    function test_lockPosition_v3_refusesAnEmptiedPosition() public {
        uint256 id = _mintV3(alice);
        uint64 at = uint64(block.timestamp + 30 days);
        vm.startPrank(alice);
        v3.decreaseLiquidity(MockV3PositionManager.DecreaseLiquidityParams(id, LIQUIDITY, 0, 0, block.timestamp));
        v3.collect(MockV3PositionManager.CollectParams(id, alice, type(uint128).max, type(uint128).max));
        vm.expectRevert(VaultFactory.NoLiquidity.selector);
        factory.lockPosition{value: FLAT}(address(v3), id, at, alice);
        vm.stopPrank();
    }

    /// Review M7: the factory checks that the vault holds the NFT once the transfer returns. A manager whose transfer
    /// reports success but moves nothing would otherwise leave a registered vault holding nothing.
    function test_lockPosition_refusesWhenTheManagerDidNotDeliverTheNft() public {
        MockV3ManagerThatKeepsTheNft buggy = new MockV3ManagerThatKeepsTheNft();
        vm.prank(factoryOwner);
        factory.setManager(address(buggy), true, PositionVault.Kind.V3);
        uint256 id = buggy.mint(alice, address(tokenA), address(tokenB), LIQUIDITY);
        uint64 at = uint64(block.timestamp + 30 days);
        vm.startPrank(alice);
        buggy.approve(address(factory), id);
        vm.expectRevert(VaultFactory.PositionNotReceived.selector);
        factory.lockPosition{value: FLAT}(address(buggy), id, at, alice);
        vm.stopPrank();
        assertEq(buggy.ownerOf(id), alice);
        assertEq(factory.vaultsOfLength(alice), 0);
    }

    // ---------------------------------------------------------------------
    // A v4 pool with hooks is refused (THREAT-MODEL Q21)
    // ---------------------------------------------------------------------

    /// A hook runs on the zero-liquidity decrease every `collect` makes: it could block collecting or take the fees
    /// through return deltas. So a v4 position whose PoolKey names any hook contract is refused at the lock, and
    /// nothing is left behind: the NFT is back with its owner, no vault is registered, no fee is kept.
    function test_lockPosition_v4_refusesAPoolWithHooks_andLeavesNothing() public {
        for (uint256 native; native < 2; ++native) {
            address currency0 = native == 1 ? NATIVE : address(tokenA);
            uint256 id = _mintV4(alice, currency0, address(tokenB));
            v4.setHooks(id, makeAddr("hook"));
            uint256 recipientBefore = feeRecipient.balance;
            uint256 aliceBefore = alice.balance;
            Snap memory snap = _snap(alice, currency0);
            vm.prank(alice);
            vm.expectRevert(VaultFactory.HookedPool.selector);
            factory.lockPosition{value: FLAT}(address(v4), id, uint64(block.timestamp + 30 days), alice);
            assertEq(v4.ownerOf(id), alice);
            assertEq(factory.vaultsOfLength(alice), 0);
            assertEq(factory.positionVaultsForTokenLength(currency0), 0);
            assertEq(factory.positionVaultsForTokenLength(address(tokenB)), 0);
            assertEq(feeRecipient.balance, recipientBefore);
            assertEq(alice.balance, aliceBefore);
            _assertNothingLeftBehind(snap, alice, currency0);
        }
    }

    /// Any non-zero hooks address is refused, whatever its permission bits; the same position without hooks locks.
    function testFuzz_lockPosition_v4_refusesEveryHookAddress(address hooks) public {
        vm.assume(hooks != address(0));
        uint256 id = _mintV4(alice, address(tokenA), address(tokenB));
        uint64 at = uint64(block.timestamp + 30 days);
        v4.setHooks(id, hooks);
        vm.prank(alice);
        vm.expectRevert(VaultFactory.HookedPool.selector);
        factory.lockPosition{value: FLAT}(address(v4), id, at, alice);

        v4.setHooks(id, address(0));
        vm.prank(alice);
        PositionVault vault = PositionVault(payable(factory.lockPosition{value: FLAT}(address(v4), id, at, alice)));
        assertEq(v4.ownerOf(id), address(vault));
    }

    /// The kind comes from the allow-list at lock time and is copied into the vault; changing it later touches only
    /// new locks.
    function test_lockPosition_copiesTheManagersKind() public {
        (PositionVault vault,) = _lockedV4(address(tokenA), address(tokenB));
        assertEq(uint8(vault.kind()), uint8(PositionVault.Kind.V4));
        vm.prank(factoryOwner);
        factory.setManager(address(v4), true, PositionVault.Kind.V3);
        assertEq(uint8(vault.kind()), uint8(PositionVault.Kind.V4));
    }
}
