// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IFeeController} from "./interfaces/IFeeController.sol";

/// @title ProPass
/// @notice Prepaid Pro time, recorded on chain. Holds nothing: the payment is forwarded in the same call.
/// Anyone can pay for any account. There are no refunds and no admin.
/// @dev The price is the FeeController's `PRO_MONTHLY` key, paid as native value (`msg.value`, 18 decimals) and read
/// on every call, so a price change applies to the next subscription only. A month is 30 days. Paying while an
/// account is still Pro extends it from its `paidUntil`; paying after it lapsed starts from now.
contract ProPass {
    bytes32 public constant PRO_MONTHLY = keccak256("PRO_MONTHLY");
    uint256 public constant MONTH = 30 days;
    uint256 public constant MAX_MONTHS = 24;

    IFeeController public immutable feeController;
    mapping(address account => uint64) public paidUntil;

    event Subscribed(address indexed account, address indexed payer, uint256 months, uint64 paidUntil);

    error BadMonths();
    error WrongFee(uint256 expected, uint256 sent);
    error FeeTransferFailed();
    error ZeroFeeController();

    constructor(IFeeController feeController_) {
        if (address(feeController_) == address(0)) revert ZeroFeeController();
        // Probe the fee key now: an immutable controller without it would leave this contract dead for good (every
        // subscription would revert with UnknownKey), as in the factories.
        feeController_.feeOf(PRO_MONTHLY);
        feeController = feeController_;
    }

    /// @notice True while `account` has paid-for time left: until, and not including, `paidUntil`.
    function isPro(address account) external view returns (bool) {
        // forge-lint: disable-next-line(block-timestamp)
        return paidUntil[account] > block.timestamp;
    }

    /// @notice Buys `months` (1 to 24) of Pro for `account`, paying exactly `months` times the monthly price.
    function subscribe(address account, uint256 months) external payable {
        if (months == 0 || months > MAX_MONTHS) revert BadMonths();
        uint256 fee = months * feeController.feeOf(PRO_MONTHLY);
        if (msg.value != fee) revert WrongFee(fee, msg.value);

        uint64 current = paidUntil[account];
        // casting to 'uint64' is safe because block.timestamp cannot reach type(uint64).max (~5.8 * 10^11 AD), and
        // months * MONTH is at most 24 * 30 days
        // forge-lint: disable-next-line(block-timestamp,unsafe-typecast)
        uint64 from = current > block.timestamp ? current : uint64(block.timestamp);
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 until = from + uint64(months * MONTH);
        paidUntil[account] = until;
        emit Subscribed(account, msg.sender, months, until);

        (bool ok,) = feeController.recipient().call{value: fee}("");
        if (!ok) revert FeeTransferFailed();
    }
}
