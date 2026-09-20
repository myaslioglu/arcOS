// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice The owner can mint up to `cap`, the maximum outstanding (circulating) supply — not a lifetime mint
/// total. Renounce ownership to freeze the supply for good.
contract MintableToken is ERC20, Ownable {
    uint8 private immutable _DECIMALS;
    uint256 public immutable cap;

    error CapExceeded();

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 supply,
        uint256 cap_,
        address holder
    ) ERC20(name_, symbol_) Ownable(holder) {
        // This contract is deployable directly (not just through TokenFactory, which already enforces this),
        // so the invariant "totalSupply() <= cap" must hold from construction, not just from mint() onward.
        if (supply > cap_) revert CapExceeded();
        _DECIMALS = decimals_;
        cap = cap_;
        _mint(holder, supply);
    }

    function mint(address to, uint256 amount) external onlyOwner {
        // totalSupply() is always <= cap, so this cannot underflow; written this way (instead of
        // totalSupply() + amount > cap) so an oversized `amount` (e.g. type(uint256).max on an uncapped
        // token) reverts with CapExceeded instead of a raw arithmetic-overflow panic.
        if (amount > cap - totalSupply()) revert CapExceeded();
        _mint(to, amount);
    }

    function decimals() public view override returns (uint8) {
        return _DECIMALS;
    }
}
