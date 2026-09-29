// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {PositionVault} from "../../src/vault/PositionVault.sol";
import {VaultTestBase} from "./VaultTestBase.sol";
import {MockToken} from "./mocks/VaultMocks.sol";
import {MockV3PositionManager, MockV4PositionManager} from "./mocks/PositionMocks.sol";

/// Shared setup for the position-vault suites: the factory of `VaultTestBase`, with a mock v3 manager and a mock v4
/// manager allow-listed, two tokens for their pools, and helpers that mint a position and lock it.
abstract contract PositionTestBase is VaultTestBase {
    using SafeCast for uint256;

    uint128 internal constant LIQUIDITY = 1_000_000 ether;
    address internal constant NATIVE = address(0);

    MockV3PositionManager internal v3;
    MockV4PositionManager internal v4;
    MockToken internal tokenA;
    MockToken internal tokenB;

    function setUp() public virtual override {
        super.setUp();
        v3 = new MockV3PositionManager();
        v4 = new MockV4PositionManager();
        tokenA = new MockToken();
        tokenB = new MockToken();
        vm.startPrank(factoryOwner);
        factory.setManager(address(v3), true, PositionVault.Kind.V3);
        factory.setManager(address(v4), true, PositionVault.Kind.V4);
        vm.stopPrank();
    }

    /// `user` mints a v3 position of tokenA/tokenB and approves the factory for it.
    function _mintV3(address user) internal returns (uint256 id) {
        id = v3.mint(user, address(tokenA), address(tokenB), LIQUIDITY);
        vm.prank(user);
        v3.approve(address(factory), id);
    }

    /// `user` mints a v4 position of `currency0`/`currency1` and approves the factory for it.
    function _mintV4(address user, address currency0, address currency1) internal returns (uint256 id) {
        id = v4.mint(user, currency0, currency1, LIQUIDITY);
        vm.prank(user);
        v4.approve(address(factory), id);
    }

    function _lockPosition(address user, address manager, uint256 id, uint256 duration, address owner_)
        internal
        returns (PositionVault)
    {
        uint256 flat = fees.feeOf(KEY_FLAT);
        uint64 at = (block.timestamp + duration).toUint64();
        vm.prank(user);
        return PositionVault(payable(factory.lockPosition{value: flat}(manager, id, at, owner_)));
    }

    /// Alice mints and locks a v3 position for herself, for 30 days.
    function _lockedV3() internal returns (PositionVault vault, uint256 id) {
        id = _mintV3(alice);
        vault = _lockPosition(alice, address(v3), id, 30 days, alice);
    }

    /// Alice mints and locks a v4 position for herself, for 30 days.
    function _lockedV4(address currency0, address currency1) internal returns (PositionVault vault, uint256 id) {
        id = _mintV4(alice, currency0, currency1);
        vault = _lockPosition(alice, address(v4), id, 30 days, alice);
    }

    /// Fees accrue on a v4 position; native value is funded here.
    function _accrueV4(uint256 id, address currency0, uint128 amount0, uint128 amount1) internal {
        uint256 native = currency0 == NATIVE ? amount0 : 0;
        vm.deal(address(this), address(this).balance + native);
        v4.accrue{value: native}(id, amount0, amount1);
    }
}
