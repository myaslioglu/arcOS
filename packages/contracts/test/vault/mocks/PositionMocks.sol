// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IV4PositionManager} from "../../../src/vault/interfaces/IPositionManagers.sol";
import {MockToken} from "./VaultMocks.sol";

/// A Uniswap v3 NonfungiblePositionManager reduced to what matters for a lock: an ERC-721 whose owner (or an approved
/// address) alone can collect fees or decrease liquidity. Fees accrue through `accrue`, which mints the fee tokens to
/// the manager. Decreasing liquidity turns principal into collectable tokens, as the real manager does, so a vault that
/// decreased liquidity would be caught by the liquidity reading and by the amounts it collects.
contract MockV3PositionManager is ERC721 {
    using SafeERC20 for IERC20;

    struct Position {
        address token0;
        address token1;
        uint128 liquidity;
        uint128 owed0;
        uint128 owed1;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    mapping(uint256 tokenId => Position) internal _positions;
    uint256 public nextId = 1;

    error NotApproved();

    constructor() ERC721("Mock v3 positions", "MV3") {}

    function mint(address to, address token0, address token1, uint128 liquidity) external returns (uint256 id) {
        id = nextId++;
        _positions[id] = Position(token0, token1, liquidity, 0, 0);
        _mint(to, id);
    }

    /// Trading fees arrive: the tokens land in the manager and become collectable by the position.
    function accrue(uint256 id, uint128 amount0, uint128 amount1) external {
        Position storage p = _positions[id];
        MockToken(p.token0).mint(address(this), amount0);
        MockToken(p.token1).mint(address(this), amount1);
        p.owed0 += amount0;
        p.owed1 += amount1;
    }

    function positions(uint256 id)
        external
        view
        returns (
            uint96,
            address,
            address token0,
            address token1,
            uint24,
            int24,
            int24,
            uint128 liquidity,
            uint256,
            uint256,
            uint128 owed0,
            uint128 owed1
        )
    {
        _requireOwned(id); // the real manager reverts "Invalid token ID" for a position that does not exist
        Position storage p = _positions[id];
        return (0, address(0), p.token0, p.token1, 3000, -60, 60, p.liquidity, 0, 0, p.owed0, p.owed1);
    }

    function liquidityOf(uint256 id) external view returns (uint128) {
        return _positions[id].liquidity;
    }

    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1) {
        _onlyApproved(params.tokenId);
        Position storage p = _positions[params.tokenId];
        uint128 a0 = p.owed0 < params.amount0Max ? p.owed0 : params.amount0Max;
        uint128 a1 = p.owed1 < params.amount1Max ? p.owed1 : params.amount1Max;
        p.owed0 -= a0;
        p.owed1 -= a1;
        if (a0 != 0) IERC20(p.token0).safeTransfer(params.recipient, a0);
        if (a1 != 0) IERC20(p.token1).safeTransfer(params.recipient, a1);
        (amount0, amount1) = (a0, a1);
    }

    /// The principal leaves a position this way only; half a unit of liquidity is worth one token of each side here.
    function decreaseLiquidity(DecreaseLiquidityParams calldata params) external payable returns (uint256, uint256) {
        _onlyApproved(params.tokenId);
        Position storage p = _positions[params.tokenId];
        p.liquidity -= params.liquidity;
        p.owed0 += params.liquidity;
        p.owed1 += params.liquidity;
        return (params.liquidity, params.liquidity);
    }

    function _onlyApproved(uint256 id) private view {
        if (!_isAuthorized(_requireOwned(id), msg.sender, id)) revert NotApproved();
    }
}

/// A Uniswap v4 PositionManager reduced to what matters for a lock. `modifyLiquidities` decodes the same strict
/// `(bytes actions, bytes[] params)` payload as v4-periphery and knows two actions, DECREASE_LIQUIDITY (0x01) and
/// TAKE_PAIR (0x11); any other action byte, a payload of the wrong shape, a passed deadline, a caller who is not the
/// owner or approved, or a credit left untaken reverts, as it would on the real manager. A decrease credits the
/// position's accrued fees plus the principal it removes, and TAKE_PAIR pays the credits out, in native value when a
/// currency is `address(0)`.
contract MockV4PositionManager is ERC721 {
    using SafeERC20 for IERC20;
    uint256 internal constant DECREASE_LIQUIDITY = 0x01;
    uint256 internal constant TAKE_PAIR = 0x11;

    struct Position {
        IV4PositionManager.PoolKey key;
        uint128 liquidity;
        uint128 owed0;
        uint128 owed1;
    }

    mapping(uint256 tokenId => Position) internal _positions;
    mapping(address currency => uint256) internal _credit;
    address[] internal _touched;
    uint256 public nextId = 1;
    uint256 public decreaseCalls;

    error NotApproved();
    error DeadlinePassed();
    error UnsupportedAction(uint256 action);
    error InputLengthMismatch();
    error CurrencyNotSettled();
    error NativeTransferFailed();

    constructor() ERC721("Mock v4 positions", "MV4") {}

    receive() external payable {}

    function mint(address to, address currency0, address currency1, uint128 liquidity) external returns (uint256 id) {
        id = nextId++;
        _positions[id].key = IV4PositionManager.PoolKey(currency0, currency1, 3000, 60, address(0));
        _positions[id].liquidity = liquidity;
        _mint(to, id);
    }

    /// Trading fees arrive. ERC-20 fee tokens are minted to the manager; native value must be sent with the call.
    function accrue(uint256 id, uint128 amount0, uint128 amount1) external payable {
        Position storage p = _positions[id];
        _fund(p.key.currency0, amount0);
        _fund(p.key.currency1, amount1);
        p.owed0 += amount0;
        p.owed1 += amount1;
    }

    function getPoolAndPositionInfo(uint256 id) external view returns (IV4PositionManager.PoolKey memory, uint256) {
        return (_positions[id].key, 0);
    }

    function getPositionLiquidity(uint256 id) external view returns (uint128) {
        return _positions[id].liquidity;
    }

    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable {
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > deadline) revert DeadlinePassed();
        (bytes memory actions, bytes[] memory params) = abi.decode(unlockData, (bytes, bytes[]));
        if (actions.length != params.length) revert InputLengthMismatch();
        for (uint256 i; i < actions.length; ++i) {
            uint256 action = uint8(actions[i]);
            if (action == DECREASE_LIQUIDITY) {
                (uint256 id, uint256 liquidity,,,) = abi.decode(params[i], (uint256, uint256, uint128, uint128, bytes));
                _decrease(id, SafeCast.toUint128(liquidity));
            } else if (action == TAKE_PAIR) {
                (address c0, address c1, address recipient) = abi.decode(params[i], (address, address, address));
                _take(c0, recipient);
                _take(c1, recipient);
            } else {
                revert UnsupportedAction(action);
            }
        }
        // Like the real manager, a call may not end with a credit left open.
        for (uint256 i; i < _touched.length; ++i) {
            if (_credit[_touched[i]] != 0) revert CurrencyNotSettled();
        }
        delete _touched;
    }

    function _decrease(uint256 id, uint128 liquidity) private {
        if (!_isAuthorized(_requireOwned(id), msg.sender, id)) revert NotApproved();
        ++decreaseCalls;
        Position storage p = _positions[id];
        p.liquidity -= liquidity;
        _credit[p.key.currency0] += p.owed0 + liquidity;
        _credit[p.key.currency1] += p.owed1 + liquidity;
        _touched.push(p.key.currency0);
        _touched.push(p.key.currency1);
        if (liquidity != 0) {
            _fund(p.key.currency0, liquidity);
            _fund(p.key.currency1, liquidity);
        }
        p.owed0 = 0;
        p.owed1 = 0;
    }

    function _take(address currency, address recipient) private {
        uint256 amount = _credit[currency];
        _credit[currency] = 0;
        if (amount == 0) return;
        if (currency == address(0)) {
            (bool ok,) = recipient.call{value: amount}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20(currency).safeTransfer(recipient, amount);
        }
    }

    function _fund(address currency, uint256 amount) private {
        if (currency == address(0)) {
            if (address(this).balance < amount) revert CurrencyNotSettled();
        } else {
            MockToken(currency).mint(address(this), amount);
        }
    }
}

/// A fee recipient whose behaviour can change after it was copied into a vault, like an address that gets blocklisted
/// later. `Accept` writes storage on every receipt, so it needs more than the 2,300 gas stipend, as a multisig wallet
/// does: it is a healthy recipient that accepts whenever it is given the gas the vault forwards. The other modes
/// revert, burn every unit of gas they are given, or revert with a megabyte of revert data.
contract MockSwitchableReceiver {
    enum Mode {
        Accept,
        Revert,
        BurnGas,
        ReturnBomb
    }

    Mode public mode;
    uint256 public received;

    function setMode(Mode mode_) external {
        mode = mode_;
    }

    receive() external payable {
        Mode m = mode;
        if (m == Mode.Revert) revert("cannot receive");
        if (m == Mode.BurnGas) {
            while (true) {}
        }
        if (m == Mode.ReturnBomb) {
            assembly {
                revert(0, 1000000)
            }
        }
        received += msg.value;
    }
}

/// An ERC-20 that misbehaves only when tokens go to `target`: it reverts, returns false, burns all gas, or reverts with a
/// megabyte of data. Every other transfer is a plain OpenZeppelin transfer.
contract MockHostileToken is ERC20 {
    enum Mode {
        None,
        Revert,
        ReturnFalse,
        BurnGas,
        ReturnBomb,
        ReturnNothing
    }

    address public target;
    Mode public mode;

    constructor() ERC20("Hostile", "HST") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setMode(address target_, Mode mode_) external {
        target = target_;
        mode = mode_;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (to == target && mode != Mode.None) {
            if (mode == Mode.Revert) revert("blocked");
            if (mode == Mode.ReturnFalse) return false;
            if (mode == Mode.BurnGas) {
                while (true) {}
            }
            if (mode == Mode.ReturnBomb) {
                assembly {
                    revert(0, 1000000)
                }
            }
            if (mode == Mode.ReturnNothing) {
                _transfer(msg.sender, to, amount);
                assembly {
                    return(0, 0)
                }
            }
        }
        return super.transfer(to, amount);
    }
}
