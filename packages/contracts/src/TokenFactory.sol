// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IFeeController} from "./interfaces/IFeeController.sol";
import {StandardToken} from "./tokens/StandardToken.sol";
import {BurnableToken} from "./tokens/BurnableToken.sol";
import {MintableToken} from "./tokens/MintableToken.sol";
import {MintableBurnableToken} from "./tokens/MintableBurnableToken.sol";

/// @title TokenFactory
/// @notice Deploys one of four audited-primitive ERC-20 templates for a flat fee paid as native USDC.
/// Holds no funds: the fee is forwarded to the fee recipient in the same call.
contract TokenFactory {
    bytes32 public constant MINT_FLAT = keccak256("MINT_FLAT");

    struct TokenParams {
        string name;
        string symbol;
        uint8 decimals;
        uint256 initialSupply;
        bool mintable;
        bool burnable;
        uint256 cap; // mintable only; 0 = uncapped
        address holder; // receives the supply, and ownership when mintable
    }

    IFeeController public immutable feeController;
    mapping(address creator => address[]) private _tokensOf;
    mapping(address token => bool) public isArcosToken;

    /// @param cap The effective cap: type(uint256).max when mintable with no explicit cap ("uncapped"), 0 when
    /// not mintable at all. `initialSupply` and `cap` are amounts (token units); the rest are identifiers/flags.
    event TokenCreated(
        address indexed creator,
        address indexed token,
        address indexed holder,
        string name,
        string symbol,
        uint8 decimals,
        uint256 initialSupply,
        uint256 cap,
        bool mintable,
        bool burnable
    );

    error WrongFee(uint256 expected, uint256 sent);
    error FeeTransferFailed();
    error BadName();
    error BadSymbol();
    error BadDecimals();
    error ZeroHolder();
    error ZeroSupply();
    error CapBelowSupply();
    error CapWithoutMint();
    error ZeroFeeController();

    constructor(IFeeController feeController_) {
        if (address(feeController_) == address(0)) revert ZeroFeeController();
        // Probe the fee key now: an immutable feeController deployed before MINT_FLAT is added would
        // otherwise be permanently dead (every createToken call would revert with UnknownKey forever).
        feeController_.feeOf(MINT_FLAT);
        feeController = feeController_;
    }

    function createToken(TokenParams calldata p) external payable returns (address token) {
        uint256 fee = feeController.feeOf(MINT_FLAT);
        if (msg.value != fee) revert WrongFee(fee, msg.value);
        _validateName(p.name);
        _validateSymbol(p.symbol);
        if (p.decimals > 18) revert BadDecimals();
        if (p.holder == address(0)) revert ZeroHolder();
        if (p.initialSupply == 0) revert ZeroSupply();
        if (!p.mintable && p.cap != 0) revert CapWithoutMint();

        uint256 effectiveCap;
        if (p.mintable) {
            effectiveCap = p.cap == 0 ? type(uint256).max : p.cap;
            if (effectiveCap < p.initialSupply) revert CapBelowSupply();
            token = p.burnable
                ? address(
                    new MintableBurnableToken(p.name, p.symbol, p.decimals, p.initialSupply, effectiveCap, p.holder)
                )
                : address(new MintableToken(p.name, p.symbol, p.decimals, p.initialSupply, effectiveCap, p.holder));
        } else {
            token = p.burnable
                ? address(new BurnableToken(p.name, p.symbol, p.decimals, p.initialSupply, p.holder))
                : address(new StandardToken(p.name, p.symbol, p.decimals, p.initialSupply, p.holder));
        }

        // Keyed on msg.sender: creating a token through a router/relayer contract files it under the
        // router's address, not the end user who called the router.
        _tokensOf[msg.sender].push(token);
        isArcosToken[token] = true;
        _emitCreated(p, token, effectiveCap);

        // Interaction last. On Arc a value transfer to a blocklisted address reverts, so this must be checked.
        (bool ok,) = feeController.recipient().call{value: msg.value}("");
        if (!ok) revert FeeTransferFailed();
    }

    /// @dev Factored out of createToken to keep that function's stack shallow — emitting this many fields
    /// (some read from calldata) inline risked "stack too deep" without enabling via-ir.
    function _emitCreated(TokenParams calldata p, address token, uint256 effectiveCap) private {
        emit TokenCreated(
            msg.sender,
            token,
            p.holder,
            p.name,
            p.symbol,
            p.decimals,
            p.initialSupply,
            effectiveCap,
            p.mintable,
            p.burnable
        );
    }

    function tokensOf(address creator) external view returns (address[] memory) {
        return _tokensOf[creator];
    }

    /// @notice Number of tokens `creator` has made. Use with `tokensOfSlice` to page through an unbounded
    /// history without ever needing `tokensOf`'s full-array copy.
    function tokenCountOf(address creator) external view returns (uint256) {
        return _tokensOf[creator].length;
    }

    /// @notice Up to `count` of `creator`'s tokens starting at `start`, in creation order. Clamps at the end
    /// of the list; a `start` at or past the end returns an empty array.
    function tokensOfSlice(address creator, uint256 start, uint256 count) external view returns (address[] memory) {
        address[] storage all = _tokensOf[creator];
        uint256 len = all.length;
        if (start >= len) return new address[](0);
        uint256 remaining = len - start;
        // Compare before adding: `count` may be arbitrarily large (even type(uint256).max), and start + count
        // must not be computed when it would overflow.
        uint256 end = count > remaining ? len : start + count;
        address[] memory out = new address[](end - start);
        for (uint256 i = start; i < end; ++i) {
            out[i - start] = all[i];
        }
        return out;
    }

    /// @dev `isArcosToken` is a provenance marker apps rely on to say "this token was created here", so the
    /// content that can end up in it is restricted on-chain rather than left to a front end. Every byte must
    /// be >= 0x20 and != 0x7F (no ASCII control characters); multi-byte UTF-8 is otherwise unrestricted.
    function _validateName(string calldata name) private pure {
        bytes memory b = bytes(name);
        if (b.length == 0 || b.length > 64) revert BadName();
        for (uint256 i; i < b.length; ++i) {
            bytes1 c = b[i];
            if (c < 0x20 || c == 0x7F) revert BadName();
        }
    }

    /// @dev Symbols are restricted to printable, non-space ASCII (0x21-0x7E) — no control characters, no
    /// spaces, and no multi-byte UTF-8 (every byte of a UTF-8 continuation/lead byte is >= 0x80).
    function _validateSymbol(string calldata symbol) private pure {
        bytes memory b = bytes(symbol);
        if (b.length == 0 || b.length > 16) revert BadSymbol();
        for (uint256 i; i < b.length; ++i) {
            bytes1 c = b[i];
            if (c < 0x21 || c > 0x7E) revert BadSymbol();
        }
    }
}
