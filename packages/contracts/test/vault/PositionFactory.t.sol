// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {PositionVault} from "../../src/vault/PositionVault.sol";
import {VaultFactory} from "../../src/vault/VaultFactory.sol";
import {PositionTestBase} from "./PositionTestBase.sol";

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
