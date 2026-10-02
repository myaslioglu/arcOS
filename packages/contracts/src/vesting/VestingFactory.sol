// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IFeeController} from "../interfaces/IFeeController.sol";
import {ArcVesting} from "./ArcVesting.sol";

/// @title VestingFactory
/// @notice Deploys one vesting wallet per schedule and funds it in the same transaction. Tokens go from the creator
/// straight to the wallet; the factory never holds them. It has no owner and no admin function.
/// @dev Each wallet is a full contract, not an EIP-1167 clone: OpenZeppelin's VestingWallet keeps its schedule in
/// immutables, which a clone cannot carry. The flat fee comes from a FeeController and is paid as native value
/// (`msg.value`, 18 decimals), like the other ARC.os contracts; it is read at creation, and nothing is ever charged
/// on a release. The registries are discovery hints, not proofs: anyone can create a schedule for any beneficiary
/// and token by paying the fee, and a wallet's ownership can move after creation. Read them in pages (`...Length`
/// and `...Slice`) and ask each wallet for its own `owner()`. `isVesting` is the authoritative "made here" check.
contract VestingFactory is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    bytes32 public constant VEST_FLAT = keccak256("VEST_FLAT");
    uint64 public constant MAX_DURATION = 3650 days;
    /// @notice The largest amount a schedule can take. OpenZeppelin's curve computes `total * elapsed` with
    /// `elapsed < duration <= MAX_DURATION`, so this bound keeps that product from overflowing.
    uint256 public constant MAX_AMOUNT = type(uint256).max / MAX_DURATION;

    IFeeController public immutable feeController;
    mapping(address vesting => bool) public isVesting;
    mapping(address token => address[]) private _vestingsForToken;
    mapping(address beneficiary => address[]) private _vestingsOf;

    event VestingCreated(
        address indexed creator,
        address indexed token,
        address indexed beneficiary,
        address vesting,
        uint256 amount,
        uint64 start,
        uint64 duration,
        uint64 cliff
    );

    error WrongFee(uint256 expected, uint256 sent);
    error FeeTransferFailed();
    error BadSchedule();
    error ZeroAmount();
    error AmountTooLarge();
    error ZeroFeeController();
    error NotAToken();

    constructor(IFeeController feeController_) {
        if (address(feeController_) == address(0)) revert ZeroFeeController();
        // Probe the fee key now: an immutable controller without it would leave this factory dead for good (every
        // creation would revert with UnknownKey), as in the other factories.
        feeController_.feeOf(VEST_FLAT);
        feeController = feeController_;
    }

    /// @notice Creates a wallet that vests `amount` of `token` to `beneficiary`: nothing before `start + cliff`,
    /// linearly from `start` to `start + duration`, everything after. The caller pays the `VEST_FLAT` fee exactly,
    /// as native value, and approves this factory for `amount`.
    /// @dev `start` may be in the past (a schedule that began earlier) and at most `MAX_DURATION` from now;
    /// `duration` is 1 second to `MAX_DURATION`; `cliff` is at most `duration`. `VestingCreated.amount` is what the
    /// wallet received (its balance after the transfer minus before it), so a token that takes a cut on transfer, or
    /// rebases and rounds down, is recorded as it landed; a token that delivers nothing reverts `ZeroAmount`. Tokens
    /// already at the new address are the beneficiary's but are not counted as funding. A zero beneficiary reverts
    /// with OpenZeppelin's `OwnableInvalidOwner`.
    function createVesting(
        IERC20 token,
        address beneficiary,
        uint256 amount,
        uint64 start,
        uint64 duration,
        uint64 cliff
    ) external payable nonReentrant returns (address vesting) {
        uint256 fee = feeController.feeOf(VEST_FLAT);
        if (msg.value != fee) revert WrongFee(fee, msg.value);
        if (amount == 0) revert ZeroAmount();
        if (amount > MAX_AMOUNT) revert AmountTooLarge();
        // The start bound also keeps OpenZeppelin's uint64 cliff time (start + cliff) from overflowing.
        // forge-lint: disable-next-line(block-timestamp)
        if (duration == 0 || duration > MAX_DURATION || cliff > duration || start > block.timestamp + MAX_DURATION) {
            revert BadSchedule();
        }
        if (address(token).code.length == 0) revert NotAToken();

        vesting = address(new ArcVesting(beneficiary, start, duration, cliff));
        isVesting[vesting] = true;
        _vestingsForToken[address(token)].push(vesting);
        _vestingsOf[beneficiary].push(vesting);

        // Record what ARRIVED, not what was asked for.
        uint256 balanceBefore = token.balanceOf(vesting);
        token.safeTransferFrom(msg.sender, vesting, amount);
        uint256 balanceAfter = token.balanceOf(vesting);
        if (balanceAfter <= balanceBefore) revert ZeroAmount();
        emit VestingCreated(
            msg.sender, address(token), beneficiary, vesting, balanceAfter - balanceBefore, start, duration, cliff
        );

        (bool ok,) = feeController.recipient().call{value: fee}("");
        if (!ok) revert FeeTransferFailed();
    }

    /// @notice Every wallet made for `beneficiary` at creation, in order. Unbounded: prefer `vestingsOfLength` and
    /// `vestingsOfSlice`. A wallet's ownership can move later, so read each wallet's `owner()`.
    function vestingsOf(address beneficiary) external view returns (address[] memory) {
        return _vestingsOf[beneficiary];
    }

    /// @notice Every wallet made for `token`, in order. Unbounded: prefer the length and slice getters.
    function vestingsForToken(address token) external view returns (address[] memory) {
        return _vestingsForToken[token];
    }

    /// @notice The number of entries `vestingsOf(beneficiary)` would return.
    function vestingsOfLength(address beneficiary) external view returns (uint256) {
        return _vestingsOf[beneficiary].length;
    }

    function vestingsForTokenLength(address token) external view returns (uint256) {
        return _vestingsForToken[token].length;
    }

    /// @notice Up to `count` entries of `vestingsOf(beneficiary)` from index `start`, in order. The slice stops at
    /// the end of the list, and a `start` at or past the end returns an empty array: it never reverts. The same
    /// holds for `vestingsForTokenSlice`.
    function vestingsOfSlice(address beneficiary, uint256 start, uint256 count)
        external
        view
        returns (address[] memory)
    {
        return _slice(_vestingsOf[beneficiary], start, count);
    }

    function vestingsForTokenSlice(address token, uint256 start, uint256 count)
        external
        view
        returns (address[] memory)
    {
        return _slice(_vestingsForToken[token], start, count);
    }

    function _slice(address[] storage all, uint256 start, uint256 count) private view returns (address[] memory) {
        uint256 len = all.length;
        if (start >= len) return new address[](0);
        uint256 remaining = len - start;
        // Compare before adding: `count` may be as large as type(uint256).max.
        uint256 end = count > remaining ? len : start + count;
        address[] memory out = new address[](end - start);
        for (uint256 i = start; i < end; ++i) {
            out[i - start] = all[i];
        }
        return out;
    }
}
