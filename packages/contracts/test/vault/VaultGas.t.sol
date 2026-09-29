// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {LockVault} from "../../src/vault/LockVault.sol";
import {PositionVault} from "../../src/vault/PositionVault.sol";
import {VaultFactory} from "../../src/vault/VaultFactory.sol";
import {VaultTestBase} from "./VaultTestBase.sol";
import {MockToken} from "./mocks/VaultMocks.sol";

/// The gas of each entry point, logged with `forge test --match-path test/vault/VaultGas.t.sol -vv`.
///
/// What the numbers mean. Foundry runs `setUp` and each test as separate transactions, so everything the vaults need
/// is created in `setUp` and the measured call meets cold, unmodified storage, as a real transaction does. (Inside one
/// transaction a slot that was already written costs 100 gas to write again instead of 2,900 to 22,100, and a
/// measurement made after the setup work in the same test would understate every write.) The call's own frame gas
/// is read with `lastCallGas`; the 21,000 intrinsic gas and the calldata (4 gas per zero byte, 16 per other byte) are
/// added, and the transaction's target is warmed first because a transaction's target is warm.
///
/// Under `forge test --isolate`, and so under `--gas-report`, Foundry runs every call as its own transaction and
/// `lastCallGas` already includes the intrinsic gas and the calldata; the test detects that with a probe call and
/// then adds nothing, so both ways of running it report the same figure.
///
/// The token is a plain OpenZeppelin ERC-20. USDC on Arc reaches its balances through a precompile and costs
/// differently, so read the figures as the contracts' own cost plus a typical ERC-20 transfer, not as a quote.
/// The ceilings are about 25% above what was measured: they are not budgets, they make an accidental blow-up (a
/// loop, a second storage write) fail loudly.
contract VaultGasTest is VaultTestBase {
    using SafeCast for uint256;

    uint256 internal constant INTRINSIC = 21_000;

    LockVault internal plainVault; // alice's, 100 tokens, nothing pending
    LockVault internal handOverVault; // alice's, with bob already named as the pending owner
    MockToken internal freshToken; // no lock has ever used it
    MockToken internal probeToken; // only ever used to tell whether calls run as transactions of their own
    address internal freshOwner = makeAddr("freshOwner"); // owns no lock

    function setUp() public override {
        super.setUp();
        freshToken = new MockToken();
        probeToken = new MockToken();
        freshToken.mint(alice, 1_000_000 ether);
        vm.prank(alice);
        freshToken.approve(address(factory), type(uint256).max);
        plainVault = _lock(alice, token, 100 ether, 30 days, alice);
        handOverVault = _lock(alice, token, 100 ether, 30 days, alice);
        vm.prank(alice);
        handOverVault.transferOwnership(bob);
        for (uint256 i; i < 3; ++i) {
            _lock(bob, token, 100 ether, 30 days, bob); // bob already has 3 locks of this token
        }
    }

    /// EIP-2028: 4 gas per zero byte of calldata, 16 per non-zero byte.
    function _calldataGas(bytes memory data) internal pure returns (uint256 gas) {
        for (uint256 i; i < data.length; ++i) {
            gas += data[i] == 0 ? 4 : 16;
        }
    }

    /// A trivial state-changing call costs a few thousand gas as a frame, but at least the 21,000 intrinsic gas when it
    /// is run as a transaction of its own. (It has to change state: `--isolate` leaves view calls as plain frames.)
    function _isolated() internal returns (bool) {
        probeToken.mint(address(this), 0);
        return vm.lastCallGas().gasTotalUsed >= INTRINSIC;
    }

    function _measure(
        string memory name,
        address target,
        address caller,
        uint256 value,
        bytes memory data,
        uint256 ceiling
    ) internal returns (uint256 txGas) {
        bool isolated = _isolated();
        assertGt(target.code.length, 0); // touching the target warms it, as it is warm at the start of a transaction
        vm.prank(caller);
        (bool ok,) = target.call{value: value}(data);
        assertTrue(ok, "the measured call reverted");
        uint256 measured = vm.lastCallGas().gasTotalUsed;
        txGas = isolated ? measured : measured + INTRINSIC + _calldataGas(data);
        emit log_named_uint(string.concat(name, ": transaction gas"), txGas);
        assertGt(measured, 0);
        assertLt(txGas, ceiling, string.concat("over its ceiling: ", name));
    }

    function _lockData(IERC20 t, uint256 amount, address owner_) internal view returns (bytes memory) {
        return abi.encodeCall(VaultFactory.lockToken, (t, amount, (block.timestamp + 30 days).toUint64(), owner_));
    }

    // ---------------------------------------------------------------------
    // VaultFactory
    // ---------------------------------------------------------------------

    /// A first lock: the owner's and the token's registries are empty, so both grow from nothing.
    function test_gas_lockToken_plainToken_firstLockForTheOwnerAndToken() public {
        _measure(
            "lockToken, plain ERC-20, first lock for the owner and the token",
            address(factory),
            alice,
            FLAT,
            _lockData(IERC20(address(freshToken)), 100 ether, freshOwner),
            380_000
        );
    }

    function test_gas_lockToken_plainToken_aLaterLock() public {
        _measure(
            "lockToken, plain ERC-20, a later lock",
            address(factory),
            bob,
            FLAT,
            _lockData(token, 100 ether, bob),
            300_000
        );
    }

    function test_gas_lockToken_lpToken_withThePercentageFee() public {
        _measure(
            "lockToken, v2 LP token, percentage fee paid, first lock for the owner and the token",
            address(factory),
            alice,
            FLAT,
            _lockData(IERC20(address(pair)), 10_000 ether, freshOwner),
            430_000
        );
    }

    function test_gas_setManager() public {
        _measure(
            "setManager",
            address(factory),
            factoryOwner,
            0,
            abi.encodeCall(VaultFactory.setManager, (makeAddr("manager"), true, PositionVault.Kind.V3)),
            65_000
        );
    }

    // ---------------------------------------------------------------------
    // LockVault
    // ---------------------------------------------------------------------

    function test_gas_vault_extend() public {
        _measure(
            "LockVault.extend",
            address(plainVault),
            alice,
            0,
            abi.encodeCall(LockVault.extend, ((block.timestamp + 60 days).toUint64())),
            45_000
        );
    }

    function test_gas_vault_transferOwnership() public {
        _measure(
            "LockVault.transferOwnership",
            address(plainVault),
            alice,
            0,
            abi.encodeCall(LockVault.transferOwnership, (bob)),
            65_000
        );
    }

    function test_gas_vault_acceptOwnership() public {
        _measure(
            "LockVault.acceptOwnership",
            address(handOverVault),
            bob,
            0,
            abi.encodeCall(LockVault.acceptOwnership, ()),
            45_000
        );
    }

    function test_gas_vault_withdraw() public {
        vm.warp(plainVault.unlockAt());
        _measure(
            "LockVault.withdraw, plain ERC-20",
            address(plainVault),
            alice,
            0,
            abi.encodeCall(LockVault.withdraw, (bob)),
            55_000
        );
    }
}
