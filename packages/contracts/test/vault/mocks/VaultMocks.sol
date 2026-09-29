// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {LockVault} from "../../../src/vault/LockVault.sol";

/// A plain ERC-20 anyone can mint.
contract MockToken is ERC20 {
    constructor() ERC20("Mock", "MOCK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// Reverts on any transfer to or from a blocked address, like a token with a blocklist (Arc's USDC does this).
contract MockBlockableToken is ERC20 {
    mapping(address account => bool) public blocked;

    constructor() ERC20("Blockable", "BLK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address account, bool isBlocked) external {
        blocked[account] = isBlocked;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[from] && !blocked[to], "blocked");
        super._update(from, to, value);
    }
}

/// A token that is also its vault's owner. From inside its own transfer hook it tries to withdraw from the vault
/// again while the first withdraw is still running, and records how that nested call ended.
contract MockReentrantOwnerToken is ERC20 {
    LockVault public vault;
    bytes public seen; // revert data of the nested withdraw

    constructor() ERC20("Reentrant", "RE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(LockVault vault_) external {
        vault = vault_;
    }

    function withdrawFromVault(address to) external {
        vault.withdraw(to);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (address(vault) != address(0) && from == address(vault)) {
            try vault.withdraw(to) {}
            catch (bytes memory reason) {
                seen = reason;
            }
        }
    }
}
