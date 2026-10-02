// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// The mocks cast between signed and unsigned amounts the way the pools they stand for do, on test-sized values.
// forge-lint: disable-start(unsafe-typecast)

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISimPoolManager} from "../../src/sim/TradeSimulator.sol";

/// A plain ERC-20 anyone can mint, with the decimals it is given (6 for the USDC stand-in).
contract SimToken is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory symbol_, uint8 decimals_) ERC20(symbol_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// A contract that burns every bit of gas it is given.
contract GasSink {
    fallback() external {
        while (true) {}
    }
}

/// A token whose behaviour around one address (the pool, or v4's PoolManager) is set by the test: a transfer tax on buys
/// and sells, a sell block (no transfer into the pool), a blacklist that catches every buyer, a sell that burns all the
/// gas it is given (itself, or in a contract it calls), or a `transferFrom` that always reverts. It counts the
/// `transferFrom`s that went through.
contract SimTrapToken is SimToken {
    address public pool;
    address public constant TAX_WALLET = address(0x7a7);
    uint256 public buyTaxBps;
    uint256 public sellTaxBps;
    bool public sellBlocked;
    bool public blacklistBuyers;
    bool public burnGasOnSell;
    bool public transferFromBlocked;
    bool public blockContractBuyers;
    address public gasSink;
    uint256 public transferFroms;
    mapping(address account => bool) public blacklisted;
    bool private _seeding;

    constructor() SimToken("TRAP", 18) {}

    function setPool(address pool_) external {
        pool = pool_;
    }

    function setTaxes(uint256 buyBps, uint256 sellBps) external {
        (buyTaxBps, sellTaxBps) = (buyBps, sellBps);
    }

    function setSellBlocked(bool on) external {
        sellBlocked = on;
    }

    function setBlacklistBuyers(bool on) external {
        blacklistBuyers = on;
    }

    function setBurnGasOnSell(bool on) external {
        burnGasOnSell = on;
    }

    /// An anti-bot rule: a buy delivered to an address with code reverts.
    function setBlockContractBuyers(bool on) external {
        blockContractBuyers = on;
    }

    function setTransferFromBlocked(bool on) external {
        transferFromBlocked = on;
    }

    /// A sell calls `sink` with all its gas and requires the call to succeed.
    function setGasSink(address sink) external {
        gasSink = sink;
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        require(!transferFromBlocked, "transferFrom is blocked");
        transferFroms++;
        return super.transferFrom(from, to, value);
    }

    /// Seeds the pool without any of the traps applying.
    function seed(address to, uint256 amount) external {
        _seeding = true;
        _mint(to, amount);
        _seeding = false;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (_seeding || from == address(0) || pool == address(0)) return super._update(from, to, value);
        require(!blacklisted[from], "blacklisted");
        if (to == pool) {
            if (burnGasOnSell) {
                while (true) {}
            }
            if (gasSink != address(0)) {
                (bool ok,) = gasSink.call("");
                require(ok, "sink");
            }
            require(!sellBlocked, "sells are paused");
            uint256 tax = (value * sellTaxBps) / 10_000;
            super._update(from, TAX_WALLET, tax);
            return super._update(from, to, value - tax);
        }
        if (from == pool) {
            require(!(blockContractBuyers && to.code.length > 0), "no contracts");
            if (blacklistBuyers) blacklisted[to] = true;
            uint256 tax = (value * buyTaxBps) / 10_000;
            super._update(from, TAX_WALLET, tax);
            return super._update(from, to, value - tax);
        }
        super._update(from, to, value);
    }
}

/// A Uniswap v2 pair: constant product with v2's 0.3% fee, checked on balances after the transfer out, as the real
/// pair does. No LP token and no flash-swap callback: the simulator never uses either.
contract MockV2Pair {
    address public immutable token0;
    address public immutable token1;
    uint112 private _reserve0;
    uint112 private _reserve1;

    constructor(address a, address b) {
        (token0, token1) = a < b ? (a, b) : (b, a);
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (_reserve0, _reserve1, 0);
    }

    function sync() public {
        _reserve0 = uint112(IERC20(token0).balanceOf(address(this)));
        _reserve1 = uint112(IERC20(token1).balanceOf(address(this)));
    }

    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata) external {
        require(amount0Out > 0 || amount1Out > 0, "INSUFFICIENT_OUTPUT_AMOUNT");
        if (amount0Out > 0) require(IERC20(token0).transfer(to, amount0Out), "TRANSFER_FAILED");
        if (amount1Out > 0) require(IERC20(token1).transfer(to, amount1Out), "TRANSFER_FAILED");
        (uint256 adjusted0, bool in0) = _adjusted(token0, _reserve0, amount0Out);
        (uint256 adjusted1, bool in1) = _adjusted(token1, _reserve1, amount1Out);
        require(in0 || in1, "INSUFFICIENT_INPUT_AMOUNT");
        require(adjusted0 * adjusted1 >= uint256(_reserve0) * _reserve1 * 1_000_000, "K");
        sync();
    }

    /// The balance after the swap, scaled by 1000 less 3 for each unit that came in, and whether any came in.
    function _adjusted(address token, uint256 reserve, uint256 out) private view returns (uint256, bool) {
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 amountIn = balance > reserve - out ? balance - (reserve - out) : 0;
        return (balance * 1000 - amountIn * 3, amountIn > 0);
    }
}

interface IV3SwapCallback {
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

/// A Uniswap v3 pool, reduced to one constant-product range with a fee in hundredths of a bip. Exact input only. It
/// pays out first, calls back, and then requires its balance of the input to have grown by the full amount, as v3's
/// `IIA` check does, so a token that arrives short can't be sold into it.
contract MockV3Pool {
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    uint256 public calls;

    /// What `slot0` and `liquidity` answer: a mid price and some liquidity, unless the test sets them.
    uint160 public sqrtPrice = uint160(1 << 96);
    uint128 public liquidity = 1e18;

    constructor(address a, address b, uint24 fee_) {
        (token0, token1) = a < b ? (a, b) : (b, a);
        fee = fee_;
    }

    function setState(uint160 sqrtPrice_, uint128 liquidity_) external {
        (sqrtPrice, liquidity) = (sqrtPrice_, liquidity_);
    }

    /// Uniswap v3's slot0, sqrtPriceX96 first; the rest isn't read.
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (sqrtPrice, 0, 0, 0, 0, 0, true);
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        require(amountSpecified > 0, "AS");
        calls++;
        (address tokenIn, address tokenOut) = zeroForOne ? (token0, token1) : (token1, token0);
        uint256 reserveIn = IERC20(tokenIn).balanceOf(address(this));
        uint256 out = _out(tokenOut, reserveIn, uint256(amountSpecified));
        require(IERC20(tokenOut).transfer(recipient, out), "TF");
        (amount0, amount1) = zeroForOne ? (amountSpecified, -int256(out)) : (-int256(out), amountSpecified);
        IV3SwapCallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
        require(IERC20(tokenIn).balanceOf(address(this)) >= reserveIn + uint256(amountSpecified), "IIA");
    }

    function _out(address tokenOut, uint256 reserveIn, uint256 amountIn) private view returns (uint256) {
        uint256 withFee = (amountIn * (1e6 - fee)) / 1e6;
        return (withFee * IERC20(tokenOut).balanceOf(address(this))) / (reserveIn + withFee);
    }
}

interface IUnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}

/// A contract that answers every PoolManager call the simulator's `unlockCallback` makes (`sync`, `settle`, `swap`,
/// `take`) without complaint, and calls that callback itself. Without the callback's guard it would be paid.
contract PermissiveManager {
    function attack(address sim, bytes calldata data) external {
        IUnlockCallback(sim).unlockCallback(data);
    }

    function sync(address) external {}

    function settle() external payable returns (uint256) {
        return 1;
    }

    function swap(ISimPoolManager.PoolKey calldata, ISimPoolManager.SwapParams calldata, bytes calldata)
        external
        pure
        returns (int256)
    {
        return 0;
    }

    function take(address, address, uint256) external {}
}

/// Uniswap v4's PoolManager, reduced to what the simulator uses: flash accounting (`unlock`, `sync`, `settle`, `take`,
/// and every delta settled before `unlock` returns) and one constant-product pool per key, exact input only. A key with
/// the dynamic-fee flag (0x800000) charges whatever `setDynamicFee` set.
contract MockPoolManager {
    uint24 public constant DYNAMIC_FEE_FLAG = 0x800000;

    mapping(bytes32 id => mapping(address currency => uint256)) public reserves;
    mapping(address currency => int256) public deltas;
    uint256 private _nonzero;
    bool private _unlocked;
    address private _synced;
    uint256 private _syncedBalance;
    uint24 public dynamicFee;

    receive() external payable {}

    function setDynamicFee(uint24 fee) external {
        dynamicFee = fee;
    }

    /// What `extsload` answers, by slot: a seeded pool's slot0 (its price) and its liquidity, as v4's StateLibrary lays
    /// them out.
    mapping(bytes32 slot => bytes32) private _ext;

    /// Credits a pool with liquidity the test has already sent to this contract, at a mid price.
    function seed(ISimPoolManager.PoolKey calldata key, uint256 amount0, uint256 amount1) external {
        bytes32 id = keccak256(abi.encode(key));
        reserves[id][key.currency0] += amount0;
        reserves[id][key.currency1] += amount1;
        setState(key, uint160(1 << 96), 1e18);
    }

    function setState(ISimPoolManager.PoolKey calldata key, uint160 sqrtPrice, uint128 liquidity) public {
        bytes32 state = keccak256(abi.encodePacked(keccak256(abi.encode(key)), uint256(6)));
        _ext[state] = bytes32(uint256(sqrtPrice));
        _ext[bytes32(uint256(state) + 3)] = bytes32(uint256(liquidity));
    }

    function extsload(bytes32 slot) external view returns (bytes32) {
        return _ext[slot];
    }

    function unlock(bytes calldata data) external returns (bytes memory result) {
        require(!_unlocked, "AlreadyUnlocked");
        _unlocked = true;
        result = IUnlockCallback(msg.sender).unlockCallback(data);
        require(_nonzero == 0, "CurrencyNotSettled");
        _unlocked = false;
    }

    function sync(address currency) external {
        _synced = currency;
        _syncedBalance = currency == address(0) ? 0 : IERC20(currency).balanceOf(address(this));
    }

    function settle() external payable returns (uint256 paid) {
        require(_unlocked, "ManagerLocked");
        address currency = _synced;
        if (currency == address(0)) {
            paid = msg.value;
        } else {
            require(msg.value == 0, "NonzeroNativeValue");
            paid = IERC20(currency).balanceOf(address(this)) - _syncedBalance;
        }
        _synced = address(0);
        _account(currency, int256(paid));
    }

    function take(address currency, address to, uint256 amount) external {
        require(_unlocked, "ManagerLocked");
        _account(currency, -int256(amount));
        if (currency == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            require(ok, "NativeTransferFailed");
        } else {
            require(IERC20(currency).transfer(to, amount), "TF");
        }
    }

    function swap(ISimPoolManager.PoolKey calldata key, ISimPoolManager.SwapParams calldata params, bytes calldata)
        external
        returns (int256)
    {
        require(_unlocked, "ManagerLocked");
        require(params.amountSpecified < 0, "exact input only");
        (address currencyIn, address currencyOut) =
            params.zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        uint256 amountIn = uint256(-params.amountSpecified);
        uint256 out = _trade(keccak256(abi.encode(key)), key.fee, currencyIn, currencyOut, amountIn);
        _account(currencyIn, -int256(amountIn));
        _account(currencyOut, int256(out));
        (int256 amount0, int256 amount1) =
            params.zeroForOne ? (-int256(amountIn), int256(out)) : (int256(out), -int256(amountIn));
        return (amount0 << 128) | int256(uint256(int256(int128(amount1))) & type(uint128).max);
    }

    /// Moves the pool's reserves for `amountIn` in, and returns what comes out.
    function _trade(bytes32 id, uint24 keyFee, address currencyIn, address currencyOut, uint256 amountIn)
        private
        returns (uint256 out)
    {
        uint24 fee = keyFee == DYNAMIC_FEE_FLAG ? dynamicFee : keyFee;
        uint256 withFee = (amountIn * (1e6 - fee)) / 1e6;
        uint256 reserveIn = reserves[id][currencyIn];
        uint256 reserveOut = reserves[id][currencyOut];
        require(reserveOut > 0, "no liquidity");
        out = (withFee * reserveOut) / (reserveIn + withFee);
        reserves[id][currencyIn] = reserveIn + amountIn;
        reserves[id][currencyOut] = reserveOut - out;
    }

    function _account(address currency, int256 change) private {
        int256 before = deltas[currency];
        int256 next = before + change;
        if (before == 0 && next != 0) _nonzero++;
        if (before != 0 && next == 0) _nonzero--;
        deltas[currency] = next;
    }
}
// forge-lint: disable-end(unsafe-typecast)
