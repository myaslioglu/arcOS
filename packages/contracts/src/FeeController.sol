// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IFeeController} from "./interfaces/IFeeController.sol";

/// @title FeeController
/// @notice Fee values shared by every ARC.os contract. A fee can never exceed the cap fixed when its key was
/// added. A decrease applies at once; an increase only after DELAY, so users always see a raise coming.
/// @dev Flat fees are native USDC (18 decimals). Keys ending in _BPS are basis points.
contract FeeController is IFeeController, Ownable2Step {
    uint256 public constant DELAY = 48 hours;

    struct Fee {
        uint256 value;
        uint256 cap;
        uint256 pendingValue;
        uint64 pendingAt; // 0 = nothing pending
        bool exists;
    }

    mapping(bytes32 key => Fee) private _fees;
    address payable public recipient;

    event KeyAdded(bytes32 indexed key, uint256 value, uint256 cap);
    event FeeChanged(bytes32 indexed key, uint256 value);
    event FeeScheduled(bytes32 indexed key, uint256 value, uint64 effectiveAt);
    event RecipientChanged(address indexed recipient);

    error UnknownKey(bytes32 key);
    error KeyExists(bytes32 key);
    error AboveCap(uint256 value, uint256 cap);
    error NothingPending(bytes32 key);
    error TooEarly(uint64 effectiveAt);
    error ZeroRecipient();

    constructor(address owner_, address payable recipient_) Ownable(owner_) {
        if (recipient_ == address(0)) revert ZeroRecipient();
        recipient = recipient_;
        emit RecipientChanged(recipient_);
    }

    function addKey(bytes32 key, uint256 value, uint256 cap) external onlyOwner {
        if (_fees[key].exists) revert KeyExists(key);
        if (value > cap) revert AboveCap(value, cap);
        _fees[key] = Fee({value: value, cap: cap, pendingValue: 0, pendingAt: 0, exists: true});
        emit KeyAdded(key, value, cap);
    }

    function setFee(bytes32 key, uint256 value) external onlyOwner {
        Fee storage f = _get(key);
        if (value > f.cap) revert AboveCap(value, f.cap);
        if (value <= f.value) {
            f.value = value;
            f.pendingValue = 0;
            f.pendingAt = 0;
            emit FeeChanged(key, value);
        } else {
            f.pendingValue = value;
            // casting to 'uint64' is safe because block.timestamp + DELAY cannot reach type(uint64).max
            // (~5.8 * 10^11 AD) for roughly 10^11 years from now
            // forge-lint: disable-next-line(unsafe-typecast)
            f.pendingAt = uint64(block.timestamp + DELAY);
            emit FeeScheduled(key, value, f.pendingAt);
        }
    }

    /// @notice Anyone may apply a scheduled increase once its delay has passed.
    function applyPending(bytes32 key) external {
        Fee storage f = _get(key);
        if (f.pendingAt == 0) revert NothingPending(key);
        // validator clock drift is a matter of seconds and is immaterial against this 48-hour delay
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < f.pendingAt) revert TooEarly(f.pendingAt);
        f.value = f.pendingValue;
        f.pendingValue = 0;
        f.pendingAt = 0;
        emit FeeChanged(key, f.value);
    }

    function setRecipient(address payable recipient_) external onlyOwner {
        if (recipient_ == address(0)) revert ZeroRecipient();
        recipient = recipient_;
        emit RecipientChanged(recipient_);
    }

    function feeOf(bytes32 key) external view returns (uint256) {
        return _get(key).value;
    }

    function capOf(bytes32 key) external view returns (uint256) {
        return _get(key).cap;
    }

    function pendingOf(bytes32 key) external view returns (uint256 value, uint64 effectiveAt) {
        Fee storage f = _get(key);
        return (f.pendingValue, f.pendingAt);
    }

    function _get(bytes32 key) private view returns (Fee storage f) {
        f = _fees[key];
        if (!f.exists) revert UnknownKey(key);
    }
}
