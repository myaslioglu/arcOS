// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Fixed supply. No owner, no mint, no privileged function of any kind.
contract StandardToken is ERC20 {
    uint8 private immutable _DECIMALS;

    constructor(string memory name_, string memory symbol_, uint8 decimals_, uint256 supply, address holder)
        ERC20(name_, symbol_)
    {
        _DECIMALS = decimals_;
        _mint(holder, supply);
    }

    function decimals() public view override returns (uint8) {
        return _DECIMALS;
    }
}
