// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LockVault} from "../../../src/vault/LockVault.sol";
import {VaultFactory} from "../../../src/vault/VaultFactory.sol";

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

/// A Uniswap-v2-shaped LP token: `token0()`, `token1()` and `getReserves()` answer the way a real pair does (32, 32
/// and 96 bytes). It can also tax every transfer and refuse transfers that touch a blocked address.
contract MockV2Pair is ERC20 {
    address public immutable token0;
    address public immutable token1;
    uint256 public immutable transferFeeBps;
    mapping(address account => bool) public blocked;

    constructor(address token0_, address token1_, uint256 transferFeeBps_) ERC20("Mock LP", "MLP") {
        token0 = token0_;
        token1 = token1_;
        transferFeeBps = transferFeeBps_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address account, bool isBlocked) external {
        blocked[account] = isBlocked;
    }

    function getReserves() external pure returns (uint112, uint112, uint32) {
        return (1e18, 1e18, 0);
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[from] && !blocked[to], "blocked");
        if (transferFeeBps != 0 && from != address(0) && to != address(0)) {
            uint256 tax = (value * transferFeeBps) / 10_000;
            if (tax != 0) super._update(from, address(0), tax);
            value -= tax;
        }
        super._update(from, to, value);
    }
}

/// A token whose transfer hook tries to call `VaultFactory.lockToken` again, from inside the factory's own call,
/// and records how that nested call ended.
contract MockReenteringToken is ERC20 {
    VaultFactory public factory;
    bytes public seen; // revert data of the nested lockToken

    constructor() ERC20("Reentering", "REN") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(VaultFactory factory_) external {
        factory = factory_;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (address(factory) != address(0) && from != address(0) && to != address(0) && seen.length == 0) {
            try factory.lockToken(IERC20(address(this)), 1, uint64(block.timestamp + 1 days), address(this)) {}
            catch (bytes memory reason) {
                seen = reason;
            }
        }
    }
}

/// A fee recipient that cannot receive value, like an address Arc has blocklisted: every value transfer to it reverts.
contract MockRevertingReceiver {
    receive() external payable {
        revert("cannot receive");
    }
}

/// A fee recipient that tries to lock again, from inside the fee payment, and records how that nested call ended.
contract MockReenteringRecipient {
    VaultFactory public immutable factory;
    IERC20 public immutable token;
    bytes public seen; // revert data of the nested lockToken
    uint256 public received;

    constructor(VaultFactory factory_, IERC20 token_) {
        factory = factory_;
        token = token_;
    }

    receive() external payable {
        received += msg.value;
        try factory.lockToken{value: msg.value}(token, 1, uint64(block.timestamp + 1 days), address(this)) {}
        catch (bytes memory reason) {
            seen = reason;
        }
    }
}
