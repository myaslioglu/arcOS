// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IV3PositionManager, IV4PositionManager} from "./interfaces/IPositionManagers.sol";

/// @title PositionVault
/// @notice Holds one concentrated-liquidity position NFT until `unlockAt`. While locked, the owner can still
/// collect the position's trading fees; the principal can't move. The platform's share is taken from
/// collected fees only, at a rate and to a recipient fixed when the lock was made.
/// @dev The vault never calls decreaseLiquidity with a non-zero amount and never transfers the NFT before
/// `unlockAt`. Those two facts are the whole security argument; the tests and INVARIANTS.md pin them down. There is
/// no admin and no upgrade path: the owner alone can collect, extend, hand the vault over, and withdraw after
/// `unlockAt`. One clone per lock; `initialize` runs once per clone (the factory calls it in the transaction that
/// creates the clone) and never on the implementation.
/// The platform's share never blocks the owner (Q9, decided 2026-09-29, reversible): when paying the fee recipient
/// fails, the share is skipped, the owner receives the whole amount, and `PlatformShareSkipped` records it. There is
/// no pull balance and no other function that moves tokens.
contract PositionVault is Initializable, ReentrancyGuardTransient, IERC721Receiver {
    using SafeERC20 for IERC20;

    enum Kind {
        V3, // Uniswap v3's NonfungiblePositionManager only. Forks whose `positions()` differs (Slipstream) are not.
        V4
    }

    uint64 public constant MAX_DURATION = 3650 days;
    /// The gas the fee recipient's payment may use, per currency. A plain transfer, or a multisig receiving value,
    /// needs a fraction of it; a recipient or token that burns more is skipped, and costs the owner no more than this.
    uint256 public constant PLATFORM_CALL_GAS = 100_000;
    /// What a call's own costs can add on top of the gas it forwards (cold account 2,600, value 9,000, new account
    /// 25,000), with a margin for the few instructions between the check and the call.
    uint256 private constant CALL_OVERHEAD = 40_000;
    uint256 private constant BPS_DENOMINATOR = 10_000;
    // v4-periphery Actions, checked against the verified source of Arc's PositionManager (F19).
    uint8 private constant DECREASE_LIQUIDITY = 0x01;
    uint8 private constant TAKE_PAIR = 0x11;

    address public owner;
    address public pendingOwner;
    address public manager;
    uint256 public tokenId;
    uint64 public unlockAt;
    Kind public kind;
    uint16 public feeShareBps;
    address payable public feeRecipient;

    event Extended(uint64 unlockAt);
    event Collected(address indexed currency, uint256 toOwner, uint256 toPlatform);
    event PlatformShareSkipped(address indexed currency, uint256 amount);
    event Withdrawn(address indexed to);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotPendingOwner();
    error StillLocked(uint64 unlockAt);
    error BadUnlockTime();
    error BadFeeShare();
    error ZeroAddress();
    error NativeTransferFailed();
    error UnexpectedNft();
    error InsufficientGas();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        _disableInitializers(); // the implementation itself can never be initialised
    }

    function initialize(
        address owner_,
        address manager_,
        uint256 tokenId_,
        uint64 unlockAt_,
        Kind kind_,
        uint16 feeShareBps_,
        address payable feeRecipient_
    ) external initializer {
        if (owner_ == address(0) || manager_ == address(0) || feeRecipient_ == address(0)) {
            revert ZeroAddress();
        }
        if (feeShareBps_ > BPS_DENOMINATOR) revert BadFeeShare();
        _requireInWindow(unlockAt_);
        owner = owner_;
        manager = manager_;
        tokenId = tokenId_;
        unlockAt = unlockAt_;
        kind = kind_;
        feeShareBps = feeShareBps_;
        feeRecipient = feeRecipient_;
    }

    /// @notice The position's two currencies, as its manager reports them. On v4, `address(0)` is the native currency.
    function currencies() public view returns (address currency0, address currency1) {
        if (kind == Kind.V3) {
            (,, currency0, currency1,,,,,,,,) = IV3PositionManager(manager).positions(tokenId);
        } else {
            (IV4PositionManager.PoolKey memory key,) = IV4PositionManager(manager).getPoolAndPositionInfo(tokenId);
            (currency0, currency1) = (key.currency0, key.currency1);
        }
    }

    /// @notice Collects accrued trading fees and splits them. Principal is untouched. Whatever the vault holds of the
    /// pool's two currencies is split the same way, since it cannot tell a donation from a fee.
    function collect() external onlyOwner nonReentrant {
        (address c0, address c1) = currencies();
        if (kind == Kind.V3) _collectV3();
        else _collectV4(c0, c1);
        _split(c0);
        if (c1 != c0) _split(c1);
    }

    /// @notice The lock can only ever get longer, and never further out than `MAX_DURATION` from now. On a lock that
    /// has already expired the new time must still be in the future.
    function extend(uint64 newUnlockAt) external onlyOwner {
        if (newUnlockAt <= unlockAt) revert BadUnlockTime();
        _requireInWindow(newUnlockAt);
        unlockAt = newUnlockAt;
        emit Extended(newUnlockAt);
    }

    /// @notice Sends the position NFT to `to`. Owner only, at or after `unlockAt`.
    function withdraw(address to) external onlyOwner nonReentrant {
        // validator clock drift is a matter of seconds and is immaterial against a lock measured in days
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < unlockAt) revert StillLocked(unlockAt);
        if (to == address(0)) revert ZeroAddress();
        emit Withdrawn(to);
        IV3PositionManager(manager).safeTransferFrom(address(this), to, tokenId); // same ERC-721 call on v4
    }

    /// @notice Starts a two-step ownership transfer. `address(0)` cancels a pending one; a new call replaces it.
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

    /// @notice Accepts only the position this vault was made for, from its own manager: any other NFT would be stuck
    /// here for good, since `withdraw` sends `tokenId` alone.
    function onERC721Received(address, address, uint256 id, bytes calldata) external view returns (bytes4) {
        if (msg.sender != manager || id != tokenId) revert UnexpectedNft();
        return IERC721Receiver.onERC721Received.selector;
    }

    /// v4 pools may pay fees in the native currency.
    receive() external payable {}

    function _collectV3() private {
        IV3PositionManager(manager)
            .collect(
                IV3PositionManager.CollectParams({
                tokenId: tokenId, recipient: address(this), amount0Max: type(uint128).max, amount1Max: type(uint128).max
            })
            );
    }

    function _collectV4(address c0, address c1) private {
        bytes memory actions = abi.encodePacked(DECREASE_LIQUIDITY, TAKE_PAIR);
        bytes[] memory params = new bytes[](2);
        // A zero-liquidity decrease settles accrued fees without touching principal.
        params[0] = abi.encode(tokenId, uint256(0), uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(c0, c1, address(this));
        IV4PositionManager(manager).modifyLiquidities(abi.encode(actions, params), block.timestamp);
    }

    /// @dev Pays the platform its share first, as an attempt that cannot revert, then the owner the rest. If the
    /// platform cannot be paid, its share goes to the owner. The share rounds down.
    function _split(address currency) private {
        uint256 amount = currency == address(0) ? address(this).balance : IERC20(currency).balanceOf(address(this));
        if (amount == 0) return;
        uint256 toPlatform = (amount * feeShareBps) / BPS_DENOMINATOR;
        if (toPlatform != 0 && !_tryPayPlatform(currency, toPlatform)) {
            emit PlatformShareSkipped(currency, toPlatform);
            toPlatform = 0;
        }
        uint256 toOwner = amount - toPlatform;
        emit Collected(currency, toOwner, toPlatform);
        if (currency == address(0)) {
            (bool ok,) = payable(owner).call{value: toOwner}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20(currency).safeTransfer(owner, toOwner);
        }
    }

    /// @dev One attempt to pay the fee recipient, with at most PLATFORM_CALL_GAS and at most 32 bytes of return data
    /// copied, so a recipient (or a token acting for it) can neither burn the owner's gas nor make it pay for a large
    /// revert. The whole bounded gas must be available first: otherwise the owner could send just too little gas for
    /// the payment and keep the platform's share, so the call reverts instead. An ERC-20 payment succeeds as SafeERC20
    /// defines it: the call succeeds and returns nothing (from a contract) or returns true.
    function _tryPayPlatform(address currency, uint256 amount) private returns (bool ok) {
        if (gasleft() < (PLATFORM_CALL_GAS * 64) / 63 + CALL_OVERHEAD) revert InsufficientGas();
        address to = feeRecipient;
        uint256 gasLimit = PLATFORM_CALL_GAS;
        if (currency == address(0)) {
            assembly ("memory-safe") {
                ok := call(gasLimit, to, amount, 0, 0, 0, 0)
            }
        } else {
            bytes memory data = abi.encodeCall(IERC20.transfer, (to, amount));
            uint256 size;
            uint256 word;
            assembly ("memory-safe") {
                ok := call(gasLimit, currency, 0, add(data, 0x20), mload(data), 0, 0x20)
                size := returndatasize()
                word := mload(0)
            }
            ok = ok && (size == 0 ? currency.code.length != 0 : size >= 32 && word == 1);
        }
    }

    /// @dev An unlock time must be in the future and no further out than `MAX_DURATION` from now.
    function _requireInWindow(uint64 time) private view {
        // validator clock drift is a matter of seconds and is immaterial against a lock measured in days
        // forge-lint: disable-next-line(block-timestamp)
        if (time <= block.timestamp || time > block.timestamp + MAX_DURATION) revert BadUnlockTime();
    }
}
