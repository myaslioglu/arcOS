// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {FeeController} from "../../src/FeeController.sol";
import {LockVault} from "../../src/vault/LockVault.sol";
import {VaultFactory} from "../../src/vault/VaultFactory.sol";
import {MockToken, MockV2Pair} from "./mocks/VaultMocks.sol";

/// Shared setup for the VaultFactory suites: a FeeController with the three lock keys at the design's values, a
/// factory on top of it, a plain token, an LP-shaped token, and two funded users who have approved the factory.
abstract contract VaultTestBase is Test {
    using SafeCast for uint256;

    uint256 internal constant FLAT = 30 ether; // 30 USDC, as native value (18 decimals)
    uint256 internal constant FLAT_CAP = 150 ether;
    uint256 internal constant LP_BPS = 50;
    uint256 internal constant LP_BPS_CAP = 100;
    uint256 internal constant SHARE_BPS = 200;
    uint256 internal constant SHARE_BPS_CAP = 500;
    uint256 internal constant START_BALANCE = 1_000_000_000 ether;

    bytes32 internal constant KEY_FLAT = keccak256("LOCK_FLAT");
    bytes32 internal constant KEY_LP = keccak256("LOCK_LP_BPS");
    bytes32 internal constant KEY_SHARE = keccak256("LOCK_FEE_SHARE_BPS");

    address internal feeOwner = makeAddr("feeOwner");
    address payable internal feeRecipient = payable(makeAddr("feeRecipient"));
    address internal factoryOwner = makeAddr("factoryOwner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal stranger = makeAddr("stranger");

    FeeController internal fees;
    VaultFactory internal factory;
    MockToken internal token;
    MockV2Pair internal pair;

    /// What a failed lock must leave exactly as it found it.
    struct Snap {
        uint256 ownerVaults;
        uint256 tokenVaults;
        uint256 factoryNonce;
        address predicted;
    }

    function setUp() public virtual {
        fees = _newFeeController(FLAT, FLAT_CAP, LP_BPS, LP_BPS_CAP, SHARE_BPS, SHARE_BPS_CAP);
        factory = new VaultFactory(factoryOwner, fees);
        token = new MockToken();
        pair = new MockV2Pair(address(token), address(new MockToken()), 0);
        _fundAndApprove(alice);
        _fundAndApprove(bob);
    }

    function _fundAndApprove(address user) internal {
        vm.deal(user, 10_000 ether);
        token.mint(user, START_BALANCE);
        pair.mint(user, START_BALANCE);
        vm.startPrank(user);
        token.approve(address(factory), type(uint256).max);
        pair.approve(address(factory), type(uint256).max);
        vm.stopPrank();
    }

    function _newFeeController(
        uint256 flat,
        uint256 flatCap,
        uint256 lpBps,
        uint256 lpBpsCap,
        uint256 shareBps,
        uint256 shareBpsCap
    ) internal returns (FeeController c) {
        c = new FeeController(feeOwner, feeRecipient);
        vm.startPrank(feeOwner);
        c.addKey(KEY_FLAT, flat, flatCap);
        c.addKey(KEY_LP, lpBps, lpBpsCap);
        c.addKey(KEY_SHARE, shareBps, shareBpsCap);
        vm.stopPrank();
    }

    /// `user` locks `amount` of `token_` for `duration` seconds, for `owner_`, paying the flat fee.
    function _lock(address user, IERC20 token_, uint256 amount, uint256 duration, address owner_)
        internal
        returns (LockVault)
    {
        uint256 flat = fees.feeOf(KEY_FLAT); // read before the prank: a call in between would consume it
        uint64 at = (block.timestamp + duration).toUint64();
        vm.prank(user);
        return LockVault(factory.lockToken{value: flat}(token_, amount, at, owner_));
    }

    function _snap(address owner_, address token_) internal view returns (Snap memory s) {
        s.ownerVaults = factory.vaultsOfLength(owner_);
        s.tokenVaults = factory.vaultsForTokenLength(token_);
        s.factoryNonce = vm.getNonce(address(factory));
        s.predicted = vm.computeCreateAddress(address(factory), s.factoryNonce);
    }

    /// A failed lock must not leave a vault, a registry entry, a moved nonce, or value in the factory.
    function _assertNothingLeftBehind(Snap memory s, address owner_, address token_) internal view {
        assertEq(factory.vaultsOfLength(owner_), s.ownerVaults, "vaultsOf grew");
        assertEq(factory.vaultsForTokenLength(token_), s.tokenVaults, "vaultsForToken grew");
        assertFalse(factory.isVault(s.predicted), "the would-be vault is registered");
        assertEq(s.predicted.code.length, 0, "the would-be vault has code");
        assertEq(vm.getNonce(address(factory)), s.factoryNonce, "the factory's nonce moved");
        assertEq(address(factory).balance, 0, "the factory holds value");
    }
}
