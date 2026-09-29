// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LockVault} from "../../src/vault/LockVault.sol";
import {VaultTestBase} from "./VaultTestBase.sol";
import {MockToken} from "./mocks/VaultMocks.sol";

/// The three registries and their bounded reads. `vaultsOf` and `vaultsForToken` are filled by real locks. Nothing can
/// fill `positionVaultsForToken` until the position vault exists, so its storage is seeded directly; a canary read
/// through the getters fails loudly if the slot below ever moves.
contract VaultRegistryTest is VaultTestBase {
    /// Slot of `VaultFactory._positionVaultsForToken` (`forge inspect VaultFactory storage-layout`).
    uint256 internal constant POSITION_REGISTRY_SLOT = 6;
    uint256 internal constant N = 7;

    enum Registry {
        OwnerRegistry, // vaultsOf, keyed by `bob`
        TokenRegistry, // vaultsForToken, keyed by `token`
        PositionRegistry // positionVaultsForToken, keyed by `token`
    }

    address[] internal populated; // the same N vaults sit in all three registries, in creation order

    function setUp() public override {
        super.setUp();
        for (uint256 i; i < N; ++i) {
            populated.push(address(_lock(alice, token, 1 ether, 30 days, bob)));
        }
        _seedPositionRegistry(address(token), populated);
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _seedPositionRegistry(address key, address[] memory vaults) internal {
        bytes32 lengthSlot = keccak256(abi.encode(key, POSITION_REGISTRY_SLOT));
        vm.store(address(factory), lengthSlot, bytes32(vaults.length));
        uint256 base = uint256(keccak256(abi.encode(lengthSlot)));
        for (uint256 i; i < vaults.length; ++i) {
            vm.store(address(factory), bytes32(base + i), bytes32(uint256(uint160(vaults[i]))));
        }
        // Canary: the getters must read back exactly what was written.
        assertEq(factory.positionVaultsForTokenLength(key), vaults.length, "position registry slot moved");
        address[] memory back = factory.positionVaultsForToken(key);
        assertEq(back.length, vaults.length, "position registry slot moved");
        for (uint256 i; i < vaults.length; ++i) {
            assertEq(back[i], vaults[i], "position registry slot moved");
        }
    }

    function _key(Registry r) internal view returns (address) {
        return r == Registry.OwnerRegistry ? bob : address(token);
    }

    function _full(Registry r, address key) internal view returns (address[] memory) {
        if (r == Registry.OwnerRegistry) return factory.vaultsOf(key);
        if (r == Registry.TokenRegistry) return factory.vaultsForToken(key);
        return factory.positionVaultsForToken(key);
    }

    function _length(Registry r, address key) internal view returns (uint256) {
        if (r == Registry.OwnerRegistry) return factory.vaultsOfLength(key);
        if (r == Registry.TokenRegistry) return factory.vaultsForTokenLength(key);
        return factory.positionVaultsForTokenLength(key);
    }

    function _slice(Registry r, address key, uint256 start, uint256 count) internal view returns (address[] memory) {
        if (r == Registry.OwnerRegistry) return factory.vaultsOfSlice(key, start, count);
        if (r == Registry.TokenRegistry) return factory.vaultsForTokenSlice(key, start, count);
        return factory.positionVaultsForTokenSlice(key, start, count);
    }

    /// An independent formulation of "entries whose index lies in [start, start + count)": it filters by index and
    /// never computes an end, so it shares no clamping logic with the contract.
    function _reference(address[] memory all, uint256 start, uint256 count)
        internal
        pure
        returns (address[] memory out)
    {
        uint256 n;
        for (uint256 i; i < all.length; ++i) {
            if (i >= start && i - start < count) ++n;
        }
        out = new address[](n);
        uint256 j;
        for (uint256 i; i < all.length; ++i) {
            if (i >= start && i - start < count) out[j++] = all[i];
        }
    }

    function _assertSame(address[] memory a, address[] memory b, string memory why) internal pure {
        assertEq(a.length, b.length, why);
        for (uint256 i; i < a.length; ++i) {
            assertEq(a[i], b[i], why);
        }
    }

    // ---------------------------------------------------------------------
    // The full getters and the lengths
    // ---------------------------------------------------------------------

    function test_registries_listInCreationOrder() public view {
        for (uint256 r; r < 3; ++r) {
            Registry reg = Registry(r);
            _assertSame(_full(reg, _key(reg)), populated, "order");
        }
    }

    function test_length_matchesTheNumberOfLocks() public {
        MockToken fresh = new MockToken();
        fresh.mint(alice, 100 ether);
        vm.prank(alice);
        fresh.approve(address(factory), type(uint256).max);
        address dave = makeAddr("dave");
        assertEq(factory.vaultsOfLength(dave), 0);
        assertEq(factory.vaultsForTokenLength(address(fresh)), 0);

        _lock(alice, IERC20(address(fresh)), 1 ether, 30 days, dave);
        assertEq(factory.vaultsOfLength(dave), 1);
        assertEq(factory.vaultsForTokenLength(address(fresh)), 1);

        _lock(alice, IERC20(address(fresh)), 1 ether, 30 days, dave);
        _lock(alice, IERC20(address(fresh)), 1 ether, 30 days, dave);
        assertEq(factory.vaultsOfLength(dave), 3);
        assertEq(factory.vaultsForTokenLength(address(fresh)), 3);
        // The other registries did not move.
        assertEq(factory.vaultsOfLength(bob), N);
        assertEq(factory.vaultsForTokenLength(address(token)), N);
    }

    // ---------------------------------------------------------------------
    // Slices
    // ---------------------------------------------------------------------

    function test_slice_returnsTheRequestedWindow() public view {
        for (uint256 r; r < 3; ++r) {
            Registry reg = Registry(r);
            address key = _key(reg);
            address[] memory middle = _slice(reg, key, 1, 3);
            assertEq(middle.length, 3);
            assertEq(middle[0], populated[1]);
            assertEq(middle[2], populated[3]);

            address[] memory first = _slice(reg, key, 0, 2);
            assertEq(first.length, 2);
            assertEq(first[0], populated[0]);
            assertEq(first[1], populated[1]);

            _assertSame(_slice(reg, key, 0, N), populated, "whole list");
            address[] memory last = _slice(reg, key, N - 1, 1);
            assertEq(last.length, 1);
            assertEq(last[0], populated[N - 1]);
        }
    }

    function test_slice_clampsToTheEnd() public view {
        for (uint256 r; r < 3; ++r) {
            Registry reg = Registry(r);
            address key = _key(reg);
            address[] memory tail = _slice(reg, key, N - 2, 10);
            assertEq(tail.length, 2);
            assertEq(tail[0], populated[N - 2]);
            assertEq(tail[1], populated[N - 1]);
            assertEq(_slice(reg, key, N - 1, 2).length, 1);
            assertEq(_slice(reg, key, 0, N + 1).length, N); // one past the end of the list
        }
    }

    function test_slice_startAtOrPastEnd_returnsEmpty_neverReverts() public view {
        uint256[6] memory starts = [N, N + 1, N + 100, type(uint256).max - 1, type(uint256).max, type(uint256).max / 2];
        uint256[3] memory counts = [uint256(0), 1, type(uint256).max];
        for (uint256 r; r < 3; ++r) {
            Registry reg = Registry(r);
            for (uint256 i; i < starts.length; ++i) {
                for (uint256 j; j < counts.length; ++j) {
                    assertEq(_slice(reg, _key(reg), starts[i], counts[j]).length, 0);
                }
            }
        }
    }

    function test_slice_countZero_returnsEmpty() public view {
        for (uint256 r; r < 3; ++r) {
            Registry reg = Registry(r);
            for (uint256 start; start <= N; ++start) {
                assertEq(_slice(reg, _key(reg), start, 0).length, 0);
            }
        }
    }

    function test_slice_hugeCount_doesNotOverflow() public view {
        for (uint256 r; r < 3; ++r) {
            Registry reg = Registry(r);
            address key = _key(reg);
            // start + count would overflow a uint256 in both calls; the tail comes back and nothing reverts.
            address[] memory tail = _slice(reg, key, 2, type(uint256).max);
            assertEq(tail.length, N - 2);
            assertEq(tail[0], populated[2]);
            _assertSame(_slice(reg, key, 3, type(uint256).max - 1), _reference(populated, 3, type(uint256).max), "tail");
        }
    }

    function test_slice_emptyRegistry() public view {
        address nobody = address(0xBEEF);
        for (uint256 r; r < 3; ++r) {
            Registry reg = Registry(r);
            assertEq(_length(reg, nobody), 0);
            assertEq(_full(reg, nobody).length, 0);
            assertEq(_slice(reg, nobody, 0, 0).length, 0);
            assertEq(_slice(reg, nobody, 0, 10).length, 0);
            assertEq(_slice(reg, nobody, 5, type(uint256).max).length, 0);
            assertEq(_slice(reg, nobody, type(uint256).max, type(uint256).max).length, 0);
        }
    }

    /// Every window that starts or ends near the edges of a 7-entry list, against the independent reference.
    function test_slice_exhaustiveSmallWindows() public view {
        for (uint256 r; r < 3; ++r) {
            Registry reg = Registry(r);
            address key = _key(reg);
            for (uint256 start; start <= N + 2; ++start) {
                for (uint256 count; count <= N + 2; ++count) {
                    _assertSame(_slice(reg, key, start, count), _reference(populated, start, count), "window");
                }
            }
        }
    }

    function testFuzz_slice_matchesAReference_anyStartAndCount(uint256 start, uint256 count) public view {
        for (uint256 r; r < 3; ++r) {
            Registry reg = Registry(r);
            _assertSame(_slice(reg, _key(reg), start, count), _reference(populated, start, count), "fuzz");
        }
    }

    function testFuzz_slice_matchesAReference_nearTheList(uint8 start, uint8 count) public view {
        for (uint256 r; r < 3; ++r) {
            Registry reg = Registry(r);
            _assertSame(
                _slice(reg, _key(reg), start % 12, count % 12), _reference(populated, start % 12, count % 12), "fuzz"
            );
        }
    }

    // ---------------------------------------------------------------------
    // Behaviour that follows from how the registries are keyed
    // ---------------------------------------------------------------------

    function test_ownershipTransfer_doesNotMoveTheRegistryEntry() public {
        LockVault v = LockVault(populated[0]);
        address carol = makeAddr("carol");
        vm.prank(bob);
        v.transferOwnership(carol);
        vm.prank(carol);
        v.acceptOwnership();

        assertEq(v.owner(), carol); // the vault is the truth ...
        assertEq(factory.vaultsOfLength(carol), 0); // ... the registry stays keyed by the creator's choice
        assertEq(factory.vaultsOfLength(bob), N);
        assertEq(factory.vaultsOf(bob)[0], address(v));
    }

    function test_aLargeRegistry_canBePagedThrough() public {
        address carol = makeAddr("carol");
        uint256 total = 120;
        for (uint256 i; i < total; ++i) {
            _lock(alice, token, 1, 30 days, carol);
        }
        assertEq(factory.vaultsOfLength(carol), total);

        address[] memory all = factory.vaultsOf(carol);
        uint256 pageSize = 50;
        uint256 seen;
        for (uint256 start; start < total; start += pageSize) {
            address[] memory page = factory.vaultsOfSlice(carol, start, pageSize);
            assertLe(page.length, pageSize);
            for (uint256 i; i < page.length; ++i) {
                assertEq(page[i], all[start + i]); // in order, no gaps, no repeats
            }
            seen += page.length;
        }
        assertEq(seen, total);
        assertEq(factory.vaultsOfSlice(carol, total, pageSize).length, 0); // the page after the last is empty
    }

    function test_positionRegistry_isKeyedByToken_andSeparateFromTheTokenRegistry() public {
        address other = makeAddr("otherCurrency");
        address[] memory two = new address[](2);
        two[0] = makeAddr("positionVaultA");
        two[1] = makeAddr("positionVaultB");
        _seedPositionRegistry(other, two);

        assertEq(factory.positionVaultsForTokenLength(other), 2);
        assertEq(factory.vaultsForTokenLength(other), 0); // a different registry
        assertEq(factory.positionVaultsForTokenLength(address(token)), N); // and a different key
        address[] memory sliced = factory.positionVaultsForTokenSlice(other, 1, 5);
        assertEq(sliced.length, 1);
        assertEq(sliced[0], two[1]);
    }
}
