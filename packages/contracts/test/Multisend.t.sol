// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {FeeController} from "../src/FeeController.sol";
import {Multisend} from "../src/Multisend.sol";

contract PlainToken is ERC20 {
    constructor() ERC20("Plain", "PLN") {
        _mint(msg.sender, 1_000_000 ether);
    }
}

/// Reverts on transfers to one blocked address, like a token with a blacklist.
contract PickyToken is ERC20 {
    address public immutable blocked;

    constructor(address blocked_) ERC20("Picky", "PKY") {
        blocked = blocked_;
        _mint(msg.sender, 1_000_000 ether);
    }

    function _update(address from, address to, uint256 value) internal override {
        require(to != blocked, "blocked");
        super._update(from, to, value);
    }
}

contract Rejector {} // no receive(): native transfers to it fail

contract Reenterer {
    Multisend internal immutable target;

    constructor(Multisend target_) {
        target = target_;
    }

    receive() external payable {
        address payable[] memory to = new address payable[](1);
        uint256[] memory amounts = new uint256[](1);
        to[0] = payable(address(this));
        amounts[0] = 1;
        target.sendNative{value: 1}(to, amounts);
    }
}

contract MultisendTest is Test {
    FeeController internal fees;
    Multisend internal drop;
    address payable internal recipient = payable(makeAddr("feeRecipient"));
    address internal sender = makeAddr("sender");
    uint256 internal constant PER = 0.05 ether;
    uint256 internal constant MIN = 2 ether;

    function setUp() public {
        fees = new FeeController(address(this), recipient);
        fees.addKey(keccak256("DROP_PER_RECIPIENT"), PER, 0.5 ether);
        fees.addKey(keccak256("DROP_MIN"), MIN, 10 ether);
        drop = new Multisend(fees);
        vm.deal(sender, 1_000 ether);
    }

    function _lists(uint256 n, uint256 each) internal returns (address[] memory to, uint256[] memory amounts) {
        to = new address[](n);
        amounts = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            to[i] = makeAddr(string.concat("r", vm.toString(i)));
            amounts[i] = each;
        }
    }

    function _payable(address[] memory a) internal pure returns (address payable[] memory out) {
        out = new address payable[](a.length);
        for (uint256 i; i < a.length; ++i) {
            out[i] = payable(a[i]);
        }
    }

    function test_quote_appliesTheMinimum() public view {
        assertEq(drop.quote(10), MIN); // 10 × 0.05 = 0.5 < 2
        assertEq(drop.quote(100), 5 ether); // 100 × 0.05
    }

    function test_sendToken_movesFundsDirectly_andHoldsNothing() public {
        vm.startPrank(sender);
        PlainToken token = new PlainToken();
        (address[] memory to, uint256[] memory amounts) = _lists(100, 3 ether);
        token.approve(address(drop), 300 ether);
        drop.sendToken{value: 5 ether}(IERC20(address(token)), to, amounts);
        vm.stopPrank();
        assertEq(token.balanceOf(to[0]), 3 ether);
        assertEq(token.balanceOf(to[99]), 3 ether);
        assertEq(token.balanceOf(address(drop)), 0);
        assertEq(address(drop).balance, 0);
        assertEq(recipient.balance, 5 ether);
    }

    function test_sendToken_skipsAFailingRecipient_tokensStayWithSender() public {
        (address[] memory to, uint256[] memory amounts) = _lists(3, 10 ether);
        vm.startPrank(sender);
        PickyToken token = new PickyToken(to[1]);
        token.approve(address(drop), 30 ether);
        vm.expectEmit(true, false, false, true);
        emit Multisend.TransferFailed(to[1], 10 ether);
        drop.sendToken{value: MIN}(IERC20(address(token)), to, amounts);
        vm.stopPrank();
        assertEq(token.balanceOf(to[0]), 10 ether);
        assertEq(token.balanceOf(to[1]), 0);
        assertEq(token.balanceOf(to[2]), 10 ether);
        assertEq(token.balanceOf(sender), 1_000_000 ether - 20 ether);
    }

    function test_sendToken_rejectsANonContractToken() public {
        (address[] memory to, uint256[] memory amounts) = _lists(1, 1);
        vm.prank(sender);
        vm.expectRevert(Multisend.NotAToken.selector);
        drop.sendToken{value: MIN}(IERC20(makeAddr("eoa")), to, amounts);
    }

    function test_sendNative_delivers_refundsFailures_andHoldsNothing() public {
        (address[] memory to, uint256[] memory amounts) = _lists(4, 1 ether);
        to[1] = address(new Rejector());
        to[2] = address(0);
        uint256 before = sender.balance;
        vm.prank(sender);
        drop.sendNative{value: 4 ether + MIN}(_payable(to), amounts);
        assertEq(to[0].balance, 1 ether);
        assertEq(to[3].balance, 1 ether);
        assertEq(address(drop).balance, 0);
        assertEq(recipient.balance, MIN);
        assertEq(sender.balance, before - 2 ether - MIN); // two failed transfers came back
    }

    function test_sendNative_aReenteringRecipientJustFails() public {
        (address[] memory to, uint256[] memory amounts) = _lists(2, 1 ether);
        to[0] = address(new Reenterer(drop));
        vm.prank(sender);
        drop.sendNative{value: 2 ether + MIN}(_payable(to), amounts);
        assertEq(to[0].balance, 0);
        assertEq(to[1].balance, 1 ether);
        assertEq(address(drop).balance, 0);
    }

    function test_wrongValue_lengthMismatch_empty_tooMany() public {
        (address[] memory to, uint256[] memory amounts) = _lists(2, 1 ether);
        vm.startPrank(sender);
        vm.expectRevert(abi.encodeWithSelector(Multisend.WrongValue.selector, 2 ether + MIN, 2 ether));
        drop.sendNative{value: 2 ether}(_payable(to), amounts);

        uint256[] memory short = new uint256[](1);
        vm.expectRevert(Multisend.BadLists.selector);
        drop.sendNative{value: MIN}(_payable(to), short);

        vm.expectRevert(Multisend.BadLists.selector);
        drop.sendNative{value: MIN}(new address payable[](0), new uint256[](0));

        (address[] memory many, uint256[] memory manyAmounts) = _lists(1001, 1);
        vm.expectRevert(Multisend.BadLists.selector);
        drop.sendNative{value: 1001 + 50.05 ether}(_payable(many), manyAmounts);
        vm.stopPrank();
    }

    function testFuzz_sendNative_neverKeepsValue(uint8 n, uint64 each) public {
        uint256 count = bound(n, 1, 50);
        (address[] memory to, uint256[] memory amounts) = _lists(count, each);
        uint256 total = uint256(each) * count + drop.quote(count);
        vm.deal(sender, total);
        vm.prank(sender);
        drop.sendNative{value: total}(_payable(to), amounts);
        assertEq(address(drop).balance, 0);
    }
}
