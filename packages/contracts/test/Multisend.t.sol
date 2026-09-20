// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IFeeController} from "../src/interfaces/IFeeController.sol";
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

/// Moves funds and returns nothing at all, like USDT on mainnet Ethereum.
contract NoReturnToken {
    mapping(address => uint256) public balanceOf;

    constructor() {
        balanceOf[msg.sender] = 1_000_000 ether;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// Returns false and moves nothing — the well-behaved "I failed" response.
contract FalseReturnToken {
    mapping(address => uint256) public balanceOf;

    constructor() {
        balanceOf[msg.sender] = 1_000_000 ether;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}

/// Returns a dirty, non-canonical "truthy" word (2, not 1) and moves nothing.
contract DirtyBoolToken {
    mapping(address => uint256) public balanceOf;

    constructor() {
        balanceOf[msg.sender] = 1_000_000 ether;
    }

    function transferFrom(address, address, uint256) external pure returns (uint256) {
        return 2;
    }
}

/// Moves funds and returns more than 32 bytes; the first word is 1 (true).
contract LargeReturnToken {
    mapping(address => uint256) public balanceOf;

    constructor() {
        balanceOf[msg.sender] = 1_000_000 ether;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        assembly {
            mstore(0x00, 1)
            mstore(0x20, 0xdead)
            return(0x00, 0x40)
        }
    }
}

/// Moves funds and returns ~100 KB of data; the first word is 1 (true).
contract HugeReturnToken {
    mapping(address => uint256) public balanceOf;

    constructor() {
        balanceOf[msg.sender] = 1_000_000 ether;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        assembly {
            mstore(0x00, 1)
            return(0x00, 100000)
        }
    }
}

contract Rejector {} // no receive(): native transfers to it fail

/// A recipient whose receive() reverts, like a smart-contract wallet with a broken fallback.
contract RevertingReceiver {
    receive() external payable {
        revert("nope");
    }
}

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
        vm.expectEmit(true, true, false, true);
        emit Multisend.Drop(sender, address(token), 100, 300 ether, 0, 0);
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
        vm.expectEmit(true, true, false, true);
        emit Multisend.TransferFailed(1, to[1], 10 ether);
        vm.expectEmit(true, true, false, true);
        emit Multisend.Drop(sender, address(token), 3, 20 ether, 10 ether, 1);
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
        vm.expectEmit(true, true, false, true);
        emit Multisend.TransferFailed(1, to[1], 1 ether);
        vm.expectEmit(true, true, false, true);
        emit Multisend.TransferFailed(2, to[2], 1 ether);
        vm.expectEmit(true, true, false, true);
        emit Multisend.Drop(sender, address(0), 4, 2 ether, 2 ether, 2);
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
        vm.expectEmit(true, true, false, true);
        emit Multisend.TransferFailed(0, to[0], 1 ether);
        vm.expectEmit(true, true, false, true);
        emit Multisend.Drop(sender, address(0), 2, 1 ether, 1 ether, 1);
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

        (address[] memory many, uint256[] memory manyAmounts) = _lists(401, 1);
        vm.expectRevert(Multisend.BadLists.selector);
        drop.sendNative{value: 401 + 20.05 ether}(_payable(many), manyAmounts);
        vm.stopPrank();
    }

    function testFuzz_sendNative_neverKeepsValue(uint8 n, uint64 each) public {
        uint256 count = bound(n, 1, 50);
        uint256 eachAmount = bound(each, 1, type(uint64).max); // 0 would hit ZeroAmount
        (address[] memory to, uint256[] memory amounts) = _lists(count, eachAmount);
        uint256 total = eachAmount * count + drop.quote(count);
        vm.deal(sender, total);
        vm.prank(sender);
        drop.sendNative{value: total}(_payable(to), amounts);
        assertEq(address(drop).balance, 0);
    }

    // ---------------------------------------------------------------------
    // MAX_RECIPIENTS sized to Arc's block gas limit
    // ---------------------------------------------------------------------

    function test_sendNative_400FreshRecipients_succeedsUnderGasBudget() public {
        (address[] memory toRaw, uint256[] memory amounts) = _lists(400, 1 ether);
        address payable[] memory to = _payable(toRaw);
        uint256 fee = drop.quote(400);
        uint256 total = 400 ether + fee;
        vm.deal(sender, total);

        vm.prank(sender);
        uint256 gasBefore = gasleft();
        drop.sendNative{value: total}(to, amounts);
        uint256 gasUsed = gasBefore - gasleft();

        assertEq(to[0].balance, 1 ether);
        assertEq(to[399].balance, 1 ether);
        assertLt(gasUsed, 16_000_000);
    }

    function test_sendToken_400FreshRecipients_succeedsUnderGasBudget() public {
        vm.startPrank(sender);
        PlainToken token = new PlainToken();
        (address[] memory to, uint256[] memory amounts) = _lists(400, 3 ether);
        token.approve(address(drop), 1_200 ether);
        uint256 fee = drop.quote(400);

        uint256 gasBefore = gasleft();
        drop.sendToken{value: fee}(IERC20(address(token)), to, amounts);
        uint256 gasUsed = gasBefore - gasleft();
        vm.stopPrank();

        assertEq(token.balanceOf(to[0]), 3 ether);
        assertEq(token.balanceOf(to[399]), 3 ether);
        assertLt(gasUsed, 12_000_000);
    }

    // ---------------------------------------------------------------------
    // Zero amounts are rejected up front, from both entry points
    // ---------------------------------------------------------------------

    function test_sendNative_rejectsZeroAmount() public {
        (address[] memory to, uint256[] memory amounts) = _lists(3, 1 ether);
        amounts[1] = 0;
        vm.prank(sender);
        vm.expectRevert(abi.encodeWithSelector(Multisend.ZeroAmount.selector, 1));
        drop.sendNative{value: 2 ether + MIN}(_payable(to), amounts);
    }

    function test_sendNative_zeroAmountToContract_revertsZeroAmount_notPhantomFailure() public {
        (address[] memory to, uint256[] memory amounts) = _lists(2, 1 ether);
        to[0] = address(new Rejector());
        amounts[0] = 0;
        vm.prank(sender);
        vm.expectRevert(abi.encodeWithSelector(Multisend.ZeroAmount.selector, 0));
        drop.sendNative{value: 1 ether + MIN}(_payable(to), amounts);
    }

    function test_sendToken_rejectsZeroAmount() public {
        vm.startPrank(sender);
        PlainToken token = new PlainToken();
        (address[] memory to, uint256[] memory amounts) = _lists(3, 1 ether);
        amounts[2] = 0;
        token.approve(address(drop), 10 ether);
        vm.expectRevert(abi.encodeWithSelector(Multisend.ZeroAmount.selector, 2));
        drop.sendToken{value: MIN}(IERC20(address(token)), to, amounts);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------
    // Non-standard ERC-20 return values (SafeERC20.trySafeTransferFrom)
    // ---------------------------------------------------------------------

    function test_sendToken_noReturnData_countsAsDelivered() public {
        vm.startPrank(sender);
        NoReturnToken token = new NoReturnToken();
        (address[] memory to, uint256[] memory amounts) = _lists(2, 3 ether);
        drop.sendToken{value: MIN}(IERC20(address(token)), to, amounts);
        vm.stopPrank();
        assertEq(token.balanceOf(to[0]), 3 ether);
        assertEq(token.balanceOf(to[1]), 3 ether);
    }

    function test_sendToken_falseReturn_withoutMovingFunds_isFailed() public {
        vm.startPrank(sender);
        FalseReturnToken token = new FalseReturnToken();
        (address[] memory to, uint256[] memory amounts) = _lists(1, 3 ether);
        vm.expectEmit(true, true, false, true);
        emit Multisend.TransferFailed(0, to[0], 3 ether);
        drop.sendToken{value: MIN}(IERC20(address(token)), to, amounts);
        vm.stopPrank();
        assertEq(token.balanceOf(to[0]), 0);
    }

    function test_sendToken_dirtyBoolReturn_doesNotRevertBatch_isTreatedAsFailed() public {
        vm.startPrank(sender);
        DirtyBoolToken token = new DirtyBoolToken();
        (address[] memory to, uint256[] memory amounts) = _lists(1, 3 ether);
        vm.expectEmit(true, true, false, true);
        emit Multisend.TransferFailed(0, to[0], 3 ether);
        drop.sendToken{value: MIN}(IERC20(address(token)), to, amounts); // must not revert
        vm.stopPrank();
        assertEq(token.balanceOf(to[0]), 0);
    }

    function test_sendToken_largeReturnData_firstWordTrue_isDelivered() public {
        vm.startPrank(sender);
        LargeReturnToken token = new LargeReturnToken();
        (address[] memory to, uint256[] memory amounts) = _lists(1, 3 ether);
        drop.sendToken{value: MIN}(IERC20(address(token)), to, amounts);
        vm.stopPrank();
        assertEq(token.balanceOf(to[0]), 3 ether); // actually delivered, correctly reported
    }

    function test_sendToken_hugeReturnData_gasStaysBounded() public {
        vm.startPrank(sender);
        HugeReturnToken token = new HugeReturnToken();
        (address[] memory to, uint256[] memory amounts) = _lists(20, 1 ether);
        uint256 fee = drop.quote(20);
        uint256 gasBefore = gasleft();
        drop.sendToken{value: fee}(IERC20(address(token)), to, amounts);
        uint256 gasUsed = gasBefore - gasleft();
        vm.stopPrank();
        assertLt(gasUsed, 3_000_000);
    }

    // ---------------------------------------------------------------------
    // FeeTransferFailed (both entry points) and RefundFailed
    // ---------------------------------------------------------------------

    function test_sendNative_feeTransferFailed_whenRecipientCannotReceive() public {
        RevertingReceiver bad = new RevertingReceiver();
        fees.setRecipient(payable(address(bad)));
        (address[] memory to, uint256[] memory amounts) = _lists(2, 1 ether);
        vm.prank(sender);
        vm.expectRevert(Multisend.FeeTransferFailed.selector);
        drop.sendNative{value: 2 ether + MIN}(_payable(to), amounts);
    }

    function test_sendToken_feeTransferFailed_whenRecipientCannotReceive() public {
        RevertingReceiver bad = new RevertingReceiver();
        fees.setRecipient(payable(address(bad)));
        vm.startPrank(sender);
        PlainToken token = new PlainToken();
        (address[] memory to, uint256[] memory amounts) = _lists(2, 1 ether);
        token.approve(address(drop), 10 ether);
        vm.expectRevert(Multisend.FeeTransferFailed.selector);
        drop.sendToken{value: MIN}(IERC20(address(token)), to, amounts);
        vm.stopPrank();
    }

    function test_sendNative_refundFailed_whenSenderCannotReceiveAndARowFails() public {
        Rejector contractSender = new Rejector();
        vm.deal(address(contractSender), 10 ether);
        (address[] memory to, uint256[] memory amounts) = _lists(2, 1 ether);
        to[1] = address(new Rejector()); // this row fails, triggering a refund attempt to contractSender
        vm.prank(address(contractSender));
        vm.expectRevert(Multisend.RefundFailed.selector);
        drop.sendNative{value: 2 ether + MIN}(_payable(to), amounts);
    }

    function test_sendNative_contractSenderWithoutReceive_succeedsWhenEveryRowLands() public {
        Rejector contractSender = new Rejector();
        vm.deal(address(contractSender), 10 ether);
        (address[] memory to, uint256[] memory amounts) = _lists(2, 1 ether); // both are plain EOAs
        vm.prank(address(contractSender));
        drop.sendNative{value: 2 ether + MIN}(_payable(to), amounts);
        assertEq(to[0].balance, 1 ether);
        assertEq(to[1].balance, 1 ether);
    }

    // ---------------------------------------------------------------------
    // Constructor guards
    // ---------------------------------------------------------------------

    function test_constructor_rejectsZeroFeeController() public {
        vm.expectRevert(Multisend.ZeroFeeController.selector);
        new Multisend(IFeeController(address(0)));
    }

    function test_constructor_probesDropPerRecipientKey_revertsWhenMissing() public {
        FeeController freshFees = new FeeController(address(this), recipient);
        vm.expectRevert(abi.encodeWithSelector(FeeController.UnknownKey.selector, keccak256("DROP_PER_RECIPIENT")));
        new Multisend(freshFees);
    }

    function test_constructor_probesDropMinKey_revertsWhenMissing() public {
        FeeController freshFees = new FeeController(address(this), recipient);
        freshFees.addKey(keccak256("DROP_PER_RECIPIENT"), PER, 0.5 ether); // DROP_MIN still missing
        vm.expectRevert(abi.encodeWithSelector(FeeController.UnknownKey.selector, keccak256("DROP_MIN")));
        new Multisend(freshFees);
    }
}
