// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @title LockVault
/// @notice Holds one ERC-20 position for one owner until `unlockAt`. One clone per lock: there is no shared
/// pool, no admin, no upgrade path. The only way value leaves is `withdraw`, by the owner, after `unlockAt`.
/// @dev The vault records no amount. `withdraw` sends the vault's whole live balance of `token`, so a token that
/// takes a cut on transfer, or that rebases, needs no special case: the owner gets the balance the vault holds at
/// that moment, less whatever the token itself takes on the way out. Tokens that arrive after the lock was made (a
/// donation, an airdrop, a positive rebase) belong to the owner and leave with the rest, and `withdraw` can run
/// again for tokens that arrive after it. Tokens other than `token`, and native value forced in with
/// `selfdestruct`, cannot be recovered: nothing here can move them, by design.
/// The vault trusts `token` for its balances and transfers. A token that freezes or confiscates balances, or lies
/// about them, can defeat any lock held in it.
/// `initialize` runs once per clone (the factory calls it in the transaction that creates the clone) and never on
/// the implementation.
contract LockVault is Initializable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint64 public constant MAX_DURATION = 3650 days;

    address public owner;
    address public pendingOwner;
    IERC20 public token;
    uint64 public unlockAt;

    event Extended(uint64 unlockAt);
    event Withdrawn(address indexed to, uint256 amount);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotPendingOwner();
    error StillLocked(uint64 unlockAt);
    error BadUnlockTime();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        _disableInitializers(); // the implementation itself can never be initialised
    }

    function initialize(address owner_, IERC20 token_, uint64 unlockAt_) external initializer {
        if (owner_ == address(0)) revert ZeroAddress();
        _requireInWindow(unlockAt_);
        owner = owner_;
        token = token_;
        unlockAt = unlockAt_;
    }

    /// @notice The vault's live balance of `token`.
    function lockedAmount() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    /// @notice The lock can only ever get longer, and never further out than `MAX_DURATION` from now. On a lock that
    /// has already expired the new time must still be in the future: it re-locks, it never pretends to extend into
    /// the past.
    function extend(uint64 newUnlockAt) external onlyOwner {
        if (newUnlockAt <= unlockAt) revert BadUnlockTime();
        _requireInWindow(newUnlockAt);
        unlockAt = newUnlockAt;
        emit Extended(newUnlockAt);
    }

    /// @notice Sends the vault's whole balance of `token` to `to`. Owner only, at or after `unlockAt`. It can run
    /// again for whatever arrives later.
    function withdraw(address to) external onlyOwner nonReentrant {
        // validator clock drift is a matter of seconds and is immaterial against a lock measured in days
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < unlockAt) revert StillLocked(unlockAt);
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = token.balanceOf(address(this));
        emit Withdrawn(to, amount);
        token.safeTransfer(to, amount);
    }

    /// @notice Starts a two-step ownership transfer. `address(0)` cancels a pending one; a new call replaces it.
    /// The vault's own `owner` is the truth about who controls a lock, whoever created it.
    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
        emit OwnershipTransferStarted(owner, to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    /// @dev An unlock time must be in the future and no further out than `MAX_DURATION` from now.
    function _requireInWindow(uint64 time) private view {
        // validator clock drift is a matter of seconds and is immaterial against a lock measured in days
        // forge-lint: disable-next-line(block-timestamp)
        if (time <= block.timestamp || time > block.timestamp + MAX_DURATION) revert BadUnlockTime();
    }
}
