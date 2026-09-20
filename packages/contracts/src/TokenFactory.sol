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

    event TokenCreated(
        address indexed creator, address indexed token, string name, string symbol, bool mintable, bool burnable
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

    constructor(IFeeController feeController_) {
        feeController = feeController_;
    }

    function createToken(TokenParams calldata p) external payable returns (address token) {
        uint256 fee = feeController.feeOf(MINT_FLAT);
        if (msg.value != fee) revert WrongFee(fee, msg.value);
        if (bytes(p.name).length == 0 || bytes(p.name).length > 64) revert BadName();
        if (bytes(p.symbol).length == 0 || bytes(p.symbol).length > 16) revert BadSymbol();
        if (p.decimals > 18) revert BadDecimals();
        if (p.holder == address(0)) revert ZeroHolder();
        if (p.initialSupply == 0) revert ZeroSupply();
        if (!p.mintable && p.cap != 0) revert CapWithoutMint();

        if (p.mintable) {
            uint256 cap = p.cap == 0 ? type(uint256).max : p.cap;
            if (cap < p.initialSupply) revert CapBelowSupply();
            token = p.burnable
                ? address(new MintableBurnableToken(p.name, p.symbol, p.decimals, p.initialSupply, cap, p.holder))
                : address(new MintableToken(p.name, p.symbol, p.decimals, p.initialSupply, cap, p.holder));
        } else {
            token = p.burnable
                ? address(new BurnableToken(p.name, p.symbol, p.decimals, p.initialSupply, p.holder))
                : address(new StandardToken(p.name, p.symbol, p.decimals, p.initialSupply, p.holder));
        }

        _tokensOf[msg.sender].push(token);
        isArcosToken[token] = true;
        emit TokenCreated(msg.sender, token, p.name, p.symbol, p.mintable, p.burnable);

        // Interaction last. On Arc a value transfer to a blocklisted address reverts, so this must be checked.
        (bool ok,) = feeController.recipient().call{value: msg.value}("");
        if (!ok) revert FeeTransferFailed();
    }

    function tokensOf(address creator) external view returns (address[] memory) {
        return _tokensOf[creator];
    }
}
