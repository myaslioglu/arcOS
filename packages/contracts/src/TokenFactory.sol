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
    /// content that can end up in it is restricted on-chain rather than left to a front end. A name is 1-64 bytes
    /// of well-formed UTF-8 (Unicode Table 3-7). Its first and last byte must not be a space (0x20), so a name
    /// can't be padded with ASCII spaces into looking blank or into colliding with a trimmed display of a different
    /// name. It contains none of these code points: the controls U+0000-U+001F and U+007F-U+009F, the bidirectional
    /// controls U+061C, U+200E, U+200F, U+202A-U+202E and U+2066-U+2069 (U+202E followed by "CDSU" renders as
    /// "USDC"), the line and paragraph separators U+2028 and U+2029 (with the controls already banned, this rules
    /// out every forced line break), and the invisible spaces U+200B, U+2060 and U+FEFF. Allowed on purpose: ZWNJ
    /// and ZWJ (U+200C, U+200D), variation selectors and tag characters, which emoji need.
    function _validateName(string calldata name) private pure {
        bytes calldata b = bytes(name);
        if (b.length == 0 || b.length > 64) revert BadName();
        if (b[0] == 0x20 || b[b.length - 1] == 0x20) revert BadName();
        uint256 i;
        while (i < b.length) {
            uint256 c = uint8(b[i]);
            if (c < 0x80) {
                // U+0000-U+007F: 00-7F. The C0 controls and DEL are banned.
                if (c < 0x20 || c == 0x7F) revert BadName();
                i += 1;
            } else if (c < 0xC2) {
                // 80-BF only continue a character; C0 and C1 could only start an overlong form.
                revert BadName();
            } else if (c < 0xE0) {
                // U+0080-U+07FF: C2-DF, 80-BF. The C1 controls (below U+00A0) and U+061C are banned.
                uint256 cp = ((c & 0x1F) << 6) | _continuation(b, i + 1, 0x80, 0xBF);
                if (cp < 0xA0 || _isBidiControlLineBreakOrInvisibleSpace(cp)) revert BadName();
                i += 2;
            } else if (c < 0xF0) {
                // U+0800-U+FFFF: E0 A0-BF (no overlong form), ED 80-9F (no surrogate), other leads 80-BF; then 80-BF.
                uint256 cp = ((c & 0x0F) << 12)
                    | (_continuation(b, i + 1, c == 0xE0 ? 0xA0 : 0x80, c == 0xED ? 0x9F : 0xBF) << 6)
                    | _continuation(b, i + 2, 0x80, 0xBF);
                if (_isBidiControlLineBreakOrInvisibleSpace(cp)) revert BadName();
                i += 3;
            } else if (c < 0xF5) {
                // U+10000-U+10FFFF: F0 90-BF (no overlong form), F4 80-8F (nothing above U+10FFFF), F1-F3 80-BF;
                // then 80-BF twice. No code point this long is banned.
                _continuation(b, i + 1, c == 0xF0 ? 0x90 : 0x80, c == 0xF4 ? 0x8F : 0xBF);
                _continuation(b, i + 2, 0x80, 0xBF);
                _continuation(b, i + 3, 0x80, 0xBF);
                i += 4;
            } else {
                // F5-FF could only start a value above U+10FFFF.
                revert BadName();
            }
        }
    }

    /// @dev The low six bits of b[j], which must exist and lie in [lo, hi]: a continuation byte (80-BF, or the
    /// narrower range Table 3-7 gives the byte after E0, ED, F0 or F4).
    function _continuation(bytes calldata b, uint256 j, uint256 lo, uint256 hi) private pure returns (uint256) {
        if (j >= b.length) revert BadName();
        uint256 c = uint8(b[j]);
        if (c < lo || c > hi) revert BadName();
        return c & 0x3F;
    }

    /// @dev The twelve bidirectional controls (Unicode property Bidi_Control), the line and paragraph separators
    /// U+2028 and U+2029, and three invisible spaces. U+2028-U+202E is both separators and five bidi controls.
    function _isBidiControlLineBreakOrInvisibleSpace(uint256 cp) private pure returns (bool) {
        return cp == 0x061C || cp == 0x200E || cp == 0x200F || (cp >= 0x2028 && cp <= 0x202E)
            || (cp >= 0x2066 && cp <= 0x2069) || cp == 0x200B || cp == 0x2060 || cp == 0xFEFF;
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
