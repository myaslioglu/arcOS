// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice The owner can mint up to `cap`. Renounce ownership to freeze the supply for good.
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
        _DECIMALS = decimals_;
        cap = cap_;
        _mint(holder, supply);
    }

    function mint(address to, uint256 amount) external onlyOwner {
        if (totalSupply() + amount > cap) revert CapExceeded();
        _mint(to, amount);
    }

    function decimals() public view override returns (uint8) {
        return _DECIMALS;
    }
}
