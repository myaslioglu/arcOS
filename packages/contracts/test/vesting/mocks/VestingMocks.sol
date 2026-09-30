// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {VestingFactory} from "../../../src/vesting/VestingFactory.sol";

/// USDC on Arc, reduced to what matters here: one balance, two views. `balanceOf` is the holder's native balance
/// (18 decimals) seen with 6 decimals, and an ERC-20 transfer moves native balance without calling the receiver, as
/// Arc's precompile does. So tokens sent to a wallet through this interface also appear as native value there.
contract MockNativeMirrorUsdc is IERC20 {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant SCALE = 1e12; // 18 - 6 decimals

    mapping(address account => mapping(address spender => uint256)) private _allowances;

    function decimals() external pure returns (uint8) {
        return 6;
    }

    function totalSupply() external pure returns (uint256) {
        return 0; // not needed by any test
    }

    function allowance(address account, address spender) external view returns (uint256) {
        return _allowances[account][spender];
    }

    function balanceOf(address account) public view returns (uint256) {
        return account.balance / SCALE;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        _allowances[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = _allowances[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "allowance");
            _allowances[from][msg.sender] = allowed - amount;
        }
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        require(to != address(0), "zero");
        uint256 value = amount * SCALE;
        require(from.balance >= value, "balance");
        VM.deal(from, from.balance - value);
        VM.deal(to, to.balance + value);
        emit Transfer(from, to, amount);
    }
}

/// A token whose transfer hook tries to call `VestingFactory.createVesting` again, from inside the factory's own call,
/// and records how that nested call ended.
contract MockVestingReenteringToken is ERC20 {
    VestingFactory public factory;
    bytes public seen; // revert data of the nested createVesting

    constructor() ERC20("Reentering", "REN") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(VestingFactory factory_) external {
        factory = factory_;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (address(factory) != address(0) && from != address(0) && to != address(0) && seen.length == 0) {
            try factory.createVesting(IERC20(address(this)), address(this), 1, 0, 1 days, 0) {}
            catch (bytes memory reason) {
                seen = reason;
            }
        }
    }
}

/// A token whose `transferFrom` reports success and moves nothing.
contract MockLyingToken is ERC20 {
    constructor() ERC20("Lying", "LIE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transferFrom(address, address, uint256) public pure override returns (bool) {
        return true;
    }
}
