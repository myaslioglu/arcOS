// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {VestingWallet} from "@openzeppelin/contracts/finance/VestingWallet.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ArcVesting} from "../../src/vesting/ArcVesting.sol";
import {VestingFactory} from "../../src/vesting/VestingFactory.sol";
import {VestingTestBase} from "./VestingTestBase.sol";
import {MockToken} from "../vault/mocks/VaultMocks.sol";

/// The gas of each entry point, logged with `forge test --match-path test/vesting/VestingGas.t.sol -vv`.
///
/// Measured as `VaultGas.t.sol` does (see there for why): the state is created in `setUp`, so the measured call meets
/// cold storage as a real transaction does; the call's own frame gas comes from `lastCallGas`, and the 21,000
/// intrinsic gas and the calldata are added unless the run is `--isolate` (then they are already included). The
/// token is a plain OpenZeppelin ERC-20, not Arc's USDC. The ceilings are about 25% above what was measured: they
/// are not budgets, they make an accidental blow-up fail loudly.
contract VestingGasTest is VestingTestBase {
    uint256 internal constant INTRINSIC = 21_000;

    ArcVesting internal fresh; // bob's, nothing released yet, half vested
    ArcVesting internal partlyReleased; // bob's, one release done, more vested since
    MockToken internal freshToken; // no schedule has ever used it
    MockToken internal probeToken;
    address internal freshBeneficiary = makeAddr("freshBeneficiary");

    function setUp() public override {
        super.setUp();
        freshToken = new MockToken();
        probeToken = new MockToken();
        freshToken.mint(alice, 1_000_000 ether);
        vm.prank(alice);
        freshToken.approve(address(factory), type(uint256).max);
        fresh = _create(alice, token, bob, 1_000 ether, uint64(block.timestamp), 100 days, 0);
        partlyReleased = _create(alice, token, bob, 1_000 ether, uint64(block.timestamp), 100 days, 0);
        vm.warp(block.timestamp + 20 days);
        partlyReleased.release(address(token));
        vm.warp(block.timestamp + 30 days);
    }

    function _calldataGas(bytes memory data) internal pure returns (uint256 gas) {
        for (uint256 i; i < data.length; ++i) {
            gas += data[i] == 0 ? 4 : 16;
        }
    }

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
        assertGt(target.code.length, 0);
        vm.prank(caller);
        (bool ok,) = target.call{value: value}(data);
        assertTrue(ok, "the measured call reverted");
        uint256 measured = vm.lastCallGas().gasTotalUsed;
        txGas = isolated ? measured : measured + INTRINSIC + _calldataGas(data);
        emit log_named_uint(string.concat(name, ": transaction gas"), txGas);
        assertLt(txGas, ceiling, string.concat("over its ceiling: ", name));
    }

    function _createData(IERC20 t, address beneficiary) internal view returns (bytes memory) {
        return abi.encodeCall(
            VestingFactory.createVesting, (t, beneficiary, 1_000 ether, uint64(block.timestamp), 365 days, 90 days)
        );
    }

    function test_gas_createVesting_firstForTheBeneficiaryAndToken() public {
        _measure(
            "createVesting, first for the beneficiary and the token",
            address(factory),
            alice,
            VEST_FEE,
            _createData(IERC20(address(freshToken)), freshBeneficiary),
            875_000
        );
    }

    function test_gas_createVesting_aLaterOne() public {
        _measure("createVesting, a later one", address(factory), alice, VEST_FEE, _createData(token, bob), 835_000);
    }

    function test_gas_release_first() public {
        _measure(
            "ArcVesting.release(token), the first",
            address(fresh),
            stranger,
            0,
            abi.encodeWithSignature("release(address)", address(token)),
            82_000
        );
    }

    function test_gas_release_aLaterOne() public {
        _measure(
            "ArcVesting.release(token), a later one",
            address(partlyReleased),
            bob,
            0,
            abi.encodeWithSignature("release(address)", address(token)),
            61_000
        );
    }

    function test_gas_transferOwnership() public {
        _measure(
            "ArcVesting.transferOwnership",
            address(fresh),
            bob,
            0,
            abi.encodeCall(Ownable.transferOwnership, (carol)),
            36_000
        );
    }

    /// For completeness: the native release always reverts, so it is measured as a failing call.
    function test_gas_nativeRelease_reverts() public {
        vm.expectRevert(ArcVesting.NativeValueNotSupported.selector);
        VestingWallet(payable(address(fresh))).release();
    }
}
