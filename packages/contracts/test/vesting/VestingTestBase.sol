// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FeeController} from "../../src/FeeController.sol";
import {ArcVesting} from "../../src/vesting/ArcVesting.sol";
import {VestingFactory} from "../../src/vesting/VestingFactory.sol";
import {MockToken} from "../vault/mocks/VaultMocks.sol";

/// Shared setup for the vesting suites: a FeeController with `VEST_FLAT` at the design's value (20 USDC, cap 100), a
/// factory on top of it, a plain token, and two funded users who have approved the factory.
abstract contract VestingTestBase is Test {
    uint256 internal constant VEST_FEE = 20 ether; // 20 USDC, as native value (18 decimals)
    uint256 internal constant VEST_FEE_CAP = 100 ether;
    uint256 internal constant START_BALANCE = 1_000_000_000 ether;
    uint64 internal constant MAX_DURATION = 3650 days;

    bytes32 internal constant KEY_VEST = keccak256("VEST_FLAT");

    address internal feeOwner = makeAddr("feeOwner");
    address payable internal feeRecipient = payable(makeAddr("feeRecipient"));
    address internal alice = makeAddr("alice"); // a team treasury that creates schedules
    address internal bob = makeAddr("bob"); // a beneficiary
    address internal carol = makeAddr("carol"); // a buyer of bob's wallet
    address internal stranger = makeAddr("stranger");

    FeeController internal fees;
    VestingFactory internal factory;
    MockToken internal token;

    function setUp() public virtual {
        vm.warp(1_800_000_000); // mid-2027: start times in the past and in the future are both easy to write
        fees = new FeeController(feeOwner, feeRecipient);
        vm.prank(feeOwner);
        fees.addKey(KEY_VEST, VEST_FEE, VEST_FEE_CAP);
        factory = new VestingFactory(fees);
        token = new MockToken();
        _fundAndApprove(alice, token);
        _fundAndApprove(bob, token);
    }

    function _fundAndApprove(address user, MockToken t) internal {
        vm.deal(user, 10_000 ether);
        t.mint(user, START_BALANCE);
        vm.prank(user);
        t.approve(address(factory), type(uint256).max);
    }

    /// `user` creates a schedule paying the current fee.
    function _create(
        address user,
        IERC20 t,
        address beneficiary,
        uint256 amount,
        uint64 start,
        uint64 duration,
        uint64 cliff
    ) internal returns (ArcVesting) {
        uint256 fee = fees.feeOf(KEY_VEST); // read before the prank: a call in between would consume it
        vm.prank(user);
        return ArcVesting(payable(factory.createVesting{value: fee}(t, beneficiary, amount, start, duration, cliff)));
    }

    /// A schedule that starts now: a year long with a 90-day cliff.
    function _createStandard(uint256 amount) internal returns (ArcVesting) {
        return _create(alice, token, bob, amount, uint64(block.timestamp), 365 days, 90 days);
    }
}
