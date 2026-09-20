// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IFeeController} from "./interfaces/IFeeController.sol";

/// @title Multisend
/// @notice Sends native USDC or any ERC-20 to up to `MAX_RECIPIENTS` recipients in one transaction.
/// ERC-20 transfers go straight from the sender to each recipient; this contract never holds tokens.
/// Native value is held only for the duration of the call.
/// @dev Net-zero: this contract never keeps value from a call it makes — every wei it receives as part of a
/// call is either forwarded to a recipient, forwarded to the fee recipient, or refunded to the sender in the
/// same transaction. That is not the same as "this contract's balance is always zero": native value can be
/// force-sent to any contract (e.g. via `selfdestruct` or as a block's coinbase reward) outside of any call
/// this contract makes, and nothing here can prevent or detect that.
/// A failed refund (`RefundFailed`) reverts the whole batch by design: the sender must be able to receive
/// native value back, rather than this contract silently keeping the failed portion.
/// Each native transfer gets a fixed 40,000 gas stipend (`CALL_GAS`) — enough for a typical smart-account
/// `receive()`, too little for a malicious recipient to burn the whole batch's gas.
contract Multisend is ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant DROP_PER_RECIPIENT = keccak256("DROP_PER_RECIPIENT");
    bytes32 public constant DROP_MIN = keccak256("DROP_MIN");
    /// Sized to Arc's 30,000,000 block gas limit: ~400 fresh native recipients costs roughly 15M gas, about
    /// half the block, leaving headroom for the rest of the block's other transactions.
    uint256 public constant MAX_RECIPIENTS = 400;
    /// Enough for a smart-account receive(); too little for a recipient to burn the batch's gas.
    uint256 private constant CALL_GAS = 40_000;

    IFeeController public immutable feeController;

    /// @notice Emitted once per call, after every recipient has been attempted.
    /// @param recipients Count of entries in the batch (not an amount).
    /// @param deliveredAmount Sum of the amounts that were successfully delivered (native wei, or token units).
    /// @param failedAmount Sum of the amounts that failed to deliver — refunded to the sender for native,
    /// left with the sender (never pulled) for ERC-20.
    /// @param failedCount Count of entries that failed to deliver (not an amount).
    event Drop(
        address indexed sender,
        address indexed token,
        uint256 recipients,
        uint256 deliveredAmount,
        uint256 failedAmount,
        uint256 failedCount
    );
    /// @notice Emitted once per recipient that failed to receive its transfer.
    event TransferFailed(uint256 indexed index, address indexed recipient, uint256 amount);

    error BadLists();
    error WrongValue(uint256 expected, uint256 sent);
    error NotAToken();
    error FeeTransferFailed();
    error RefundFailed();
    error ZeroAmount(uint256 index);
    error ZeroFeeController();

    constructor(IFeeController feeController_) {
        if (address(feeController_) == address(0)) revert ZeroFeeController();
        // Probe both fee keys now: an immutable feeController deployed before either key exists would
        // otherwise be permanently dead (every call would revert with UnknownKey forever).
        feeController_.feeOf(DROP_PER_RECIPIENT);
        feeController_.feeOf(DROP_MIN);
        feeController = feeController_;
    }

    function quote(uint256 recipients) public view returns (uint256 fee) {
        fee = recipients * feeController.feeOf(DROP_PER_RECIPIENT);
        uint256 min = feeController.feeOf(DROP_MIN);
        if (fee < min) fee = min;
    }

    /// @notice Sends native value to every address in `to`, in one transaction. A recipient whose transfer
    /// fails (out of gas within `CALL_GAS`, a reverting receive(), a blocklisted address, ...) just fails that
    /// row — its amount is refunded to the sender at the end of the call — rather than reverting the batch.
    /// @dev The fee (`quote(to.length)`) prices the ATTEMPT, not the outcome: it is charged for every row
    /// submitted, including rows that go on to fail and get refunded.
    function sendNative(address payable[] calldata to, uint256[] calldata amounts) external payable nonReentrant {
        uint256 n = _checkLists(to.length, amounts.length);
        uint256 fee = quote(n);
        uint256 total;
        for (uint256 i; i < n; ++i) {
            if (amounts[i] == 0) revert ZeroAmount(i);
            total += amounts[i];
        }
        if (msg.value != total + fee) revert WrongValue(total + fee, msg.value);

        uint256 failedAmount;
        uint256 failedCount;
        for (uint256 i; i < n; ++i) {
            bool ok;
            if (to[i] != address(0)) {
                (ok,) = to[i].call{value: amounts[i], gas: CALL_GAS}("");
            }
            if (!ok) {
                failedAmount += amounts[i];
                ++failedCount;
                emit TransferFailed(i, to[i], amounts[i]);
            }
        }
        emit Drop(msg.sender, address(0), n, total - failedAmount, failedAmount, failedCount);

        _payFee(fee);
        if (failedAmount != 0) {
            (bool refunded,) = payable(msg.sender).call{value: failedAmount}("");
            if (!refunded) revert RefundFailed();
        }
    }

    /// @notice Sends `token` directly from the sender to every address in `to`, in one transaction. This
    /// contract never holds the tokens. A recipient whose transfer fails is just skipped (its tokens stay
    /// with the sender, never pulled) rather than reverting the batch.
    /// @dev The fee (`quote(to.length)`) prices the ATTEMPT, not the outcome: it is charged for every row
    /// submitted, including rows that go on to fail.
    function sendToken(IERC20 token, address[] calldata to, uint256[] calldata amounts) external payable nonReentrant {
        uint256 n = _checkLists(to.length, amounts.length);
        uint256 fee = quote(n);
        if (msg.value != fee) revert WrongValue(fee, msg.value);
        if (address(token).code.length == 0) revert NotAToken();
        for (uint256 i; i < n; ++i) {
            if (amounts[i] == 0) revert ZeroAmount(i);
        }

        uint256 delivered;
        uint256 failedAmount;
        uint256 failedCount;
        for (uint256 i; i < n; ++i) {
            // trySafeTransferFrom tolerates a token that returns nothing (treated as delivered), treats a
            // false/garbage return as a failure without reverting the batch, and — because it only reads the
            // return data's first word — costs the same whether the token returns 0 bytes or 100 KB.
            bool ok = token.trySafeTransferFrom(msg.sender, to[i], amounts[i]);
            if (ok) {
                delivered += amounts[i];
            } else {
                failedAmount += amounts[i];
                ++failedCount;
                emit TransferFailed(i, to[i], amounts[i]);
            }
        }
        emit Drop(msg.sender, address(token), n, delivered, failedAmount, failedCount);
        _payFee(fee);
    }

    function _checkLists(uint256 a, uint256 b) private pure returns (uint256) {
        if (a == 0 || a != b || a > MAX_RECIPIENTS) revert BadLists();
        return a;
    }

    function _payFee(uint256 fee) private {
        (bool ok,) = feeController.recipient().call{value: fee}("");
        if (!ok) revert FeeTransferFailed();
    }
}
