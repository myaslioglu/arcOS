// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FeeController} from "../../../src/FeeController.sol";
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

/// A fee recipient that also owns the FeeController and, the first time it is paid, points the recipient somewhere
/// else. It shows which address a single call pays: the one read when the call began.
contract MockRecipientChanger {
    FeeController public immutable fees;
    address payable public immutable next;

    constructor(FeeController fees_, address payable next_) {
        fees = fees_;
        next = next_;
    }

    function acceptOwnership() external {
        fees.acceptOwnership();
    }

    receive() external payable {
        if (fees.owner() == address(this) && fees.recipient() == address(this)) fees.setRecipient(next);
    }
}

/// Takes `feeBps` of every transfer and burns it, like a taxed token.
contract MockFeeOnTransferToken is ERC20 {
    uint256 public immutable feeBps;

    constructor(uint256 feeBps_) ERC20("Taxed", "TAX") {
        feeBps = feeBps_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 tax = (value * feeBps) / 10_000;
            if (tax != 0) super._update(from, address(0), tax);
            value -= tax;
        }
        super._update(from, to, value);
    }
}

/// Balances follow an index: balanceOf = shares * index / 1e18, so `rebase` changes every holder's balance at once.
/// A transfer moves whole shares, so it can deliver a little less than asked, as stETH does.
contract MockRebasingToken is IERC20 {
    uint256 public index = 1e18;
    uint256 public totalShares;
    mapping(address account => uint256) private _shares;
    mapping(address account => mapping(address spender => uint256)) public override allowance;

    function totalSupply() external view returns (uint256) {
        return (totalShares * index) / 1e18;
    }

    function balanceOf(address account) public view returns (uint256) {
        return (_shares[account] * index) / 1e18;
    }

    function mint(address to, uint256 amount) external {
        uint256 shares = (amount * 1e18) / index;
        _shares[to] += shares;
        totalShares += shares;
    }

    function rebase(uint256 newIndex) external {
        index = newIndex;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        uint256 shares = (amount * 1e18) / index; // rounds down
        _shares[from] -= shares;
        _shares[to] += shares;
        emit Transfer(from, to, amount);
    }
}

    /// transferFrom succeeds and returns true but moves nothing, like a token that takes 100% or is simply broken.
    contract MockZeroTransferToken {
        function balanceOf(address) external pure returns (uint256) {
            return 0;
        }

        function transferFrom(address, address, uint256) external pure returns (bool) {
            return true;
        }
    }

    /// A token that never answers balanceOf, so nothing can tell how much a transfer delivered.
    contract MockNoBalanceToken {
        function transferFrom(address, address, uint256) external pure returns (bool) {
            return true;
        }
    }

    /// Moves funds and returns nothing at all from transfer, transferFrom and approve, like USDT on Ethereum.
    contract MockNoReturnToken {
        mapping(address account => uint256) public balanceOf;
        mapping(address account => mapping(address spender => uint256)) public allowance;

        function mint(address to, uint256 amount) external {
            balanceOf[to] += amount;
        }

        function approve(address spender, uint256 amount) external {
            allowance[msg.sender][spender] = amount;
        }

        function transfer(address to, uint256 amount) external {
            balanceOf[msg.sender] -= amount;
            balanceOf[to] += amount;
        }

        function transferFrom(address from, address to, uint256 amount) external {
            allowance[from][msg.sender] -= amount;
            balanceOf[from] -= amount;
            balanceOf[to] += amount;
        }
    }

    /// Returns false from transferFrom and moves nothing.
    contract MockFalseReturnToken {
        function balanceOf(address) external pure returns (uint256) {
            return 0;
        }

        function transferFrom(address, address, uint256) external pure returns (bool) {
            return false;
        }
    }

    /// An ERC-20 whose answers to token0(), token1() and getReserves() can be set to any length, or to revert, to test
    /// how the factory decides that a token is a v2 pair.
    contract MockShapedToken is ERC20 {
        mapping(bytes4 selector => uint256) public wordsFor;
        mapping(bytes4 selector => bool) public revertsFor;

        constructor() ERC20("Shaped", "SHP") {}

        function mint(address to, uint256 amount) external {
            _mint(to, amount);
        }

        function shape(bytes4 selector, uint256 words, bool doRevert) external {
            wordsFor[selector] = words;
            revertsFor[selector] = doRevert;
        }

        fallback() external {
            if (revertsFor[msg.sig]) revert("shaped");
            uint256 words = wordsFor[msg.sig];
            assembly {
                for { let i := 0 } lt(i, words) { i := add(i, 1) } { mstore(mul(i, 0x20), 0) }
                return(0, mul(words, 0x20))
            }
        }
    }
