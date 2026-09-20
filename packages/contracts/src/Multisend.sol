// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IFeeController} from "./interfaces/IFeeController.sol";

/// @title Multisend
/// @notice Sends native USDC or any ERC-20 to up to 1,000 recipients in one transaction.
/// ERC-20 transfers go straight from the sender to each recipient; this contract never holds tokens.
/// Native value is held only for the duration of the call.
contract Multisend is ReentrancyGuard {
    bytes32 public constant DROP_PER_RECIPIENT = keccak256("DROP_PER_RECIPIENT");
    bytes32 public constant DROP_MIN = keccak256("DROP_MIN");
    uint256 public constant MAX_RECIPIENTS = 1000;
    /// Enough for a smart-account receive(); too little for a recipient to burn the batch's gas.
    uint256 private constant CALL_GAS = 40_000;

    IFeeController public immutable feeController;

    event Drop(address indexed sender, address indexed token, uint256 recipients, uint256 delivered, uint256 failed);
    event TransferFailed(address indexed recipient, uint256 amount);

    error BadLists();
    error WrongValue(uint256 expected, uint256 sent);
    error NotAToken();
    error FeeTransferFailed();
    error RefundFailed();

    constructor(IFeeController feeController_) {
        feeController = feeController_;
    }

    function quote(uint256 recipients) public view returns (uint256 fee) {
        fee = recipients * feeController.feeOf(DROP_PER_RECIPIENT);
        uint256 min = feeController.feeOf(DROP_MIN);
        if (fee < min) fee = min;
    }

    function sendNative(address payable[] calldata to, uint256[] calldata amounts) external payable nonReentrant {
        uint256 n = _checkLists(to.length, amounts.length);
        uint256 fee = quote(n);
        uint256 total;
        for (uint256 i; i < n; ++i) {
            total += amounts[i];
        }
        if (msg.value != total + fee) revert WrongValue(total + fee, msg.value);

        uint256 failed;
        for (uint256 i; i < n; ++i) {
            bool ok;
            if (to[i] != address(0)) {
                (ok,) = to[i].call{value: amounts[i], gas: CALL_GAS}("");
            }
            if (!ok) {
                failed += amounts[i];
                emit TransferFailed(to[i], amounts[i]);
            }
        }
        emit Drop(msg.sender, address(0), n, total - failed, failed);

        _payFee(fee);
        if (failed != 0) {
            (bool refunded,) = payable(msg.sender).call{value: failed}("");
            if (!refunded) revert RefundFailed();
        }
    }

    function sendToken(IERC20 token, address[] calldata to, uint256[] calldata amounts) external payable nonReentrant {
        uint256 n = _checkLists(to.length, amounts.length);
        uint256 fee = quote(n);
        if (msg.value != fee) revert WrongValue(fee, msg.value);
        if (address(token).code.length == 0) revert NotAToken();

        uint256 delivered;
        uint256 failed;
        for (uint256 i; i < n; ++i) {
            // Non-reverting transferFrom: tolerate tokens that return nothing, skip the ones that fail.
            (bool ok, bytes memory ret) =
                address(token).call(abi.encodeCall(IERC20.transferFrom, (msg.sender, to[i], amounts[i])));
            if (ok && (ret.length == 0 || (ret.length == 32 && abi.decode(ret, (bool))))) {
                delivered += amounts[i];
            } else {
                failed += amounts[i];
                emit TransferFailed(to[i], amounts[i]);
            }
        }
        emit Drop(msg.sender, address(token), n, delivered, failed);
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
