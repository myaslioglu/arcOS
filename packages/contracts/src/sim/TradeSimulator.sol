// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// The pool interfaces the simulator calls, declared here from their ABIs: nothing is imported from Uniswap (v4-core's
/// libraries are BUSL-1.1), and only the functions used are listed.
interface ISimERC20 {
    function balanceOf(address account) external view returns (uint256);
}

interface ISimV2Pair {
    function token0() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

/// Uniswap v3's pool, and Aerodrome Slipstream's, which keeps the same `swap` and calls back `uniswapV3SwapCallback`.
interface ISimV3Pool {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

/// Uniswap v4's PoolManager. `Currency` is an address (address(0) is the native currency); `BalanceDelta` is an int256
/// holding amount0 in its upper 128 bits and amount1 in its lower 128, each signed, positive when owed to the caller.
interface ISimPoolManager {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
    }

    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey calldata key, SwapParams calldata params, bytes calldata hookData) external returns (int256);
    function sync(address currency) external;
    function settle() external payable returns (uint256 paid);
    function take(address currency, address to, uint256 amount) external;
}

/// Buys a token with USDC from one pool and sells everything it got straight back into the same pool, then reports what
/// each leg moved. It is never deployed: Inspector runs it in one `eth_call` whose state override puts this runtime code,
/// and a USDC balance, at a throwaway address S, and sends the call from S to S. The call then comes from an address
/// where `tx.origin == msg.sender`, as a wallet's would. On Arc the native balance is also the USDC ERC-20 balance, so the
/// one override funds both forms.
///
/// It swaps against the pool contracts directly, never through a router: v2 through the pair's `swap`, v3 (and Aerodrome
/// Slipstream) through `swap` and its callback, v4 through `unlock` and its callback.
///
/// Each leg runs as a call to itself with a gas budget, so `simulate` never reverts on a leg's account and can tell a leg
/// that reverted from one that ran out of the gas it was given (which says nothing about the token). Amounts are what the
/// balances say, not what the pools were asked for, so a transfer tax shows up as the difference.
contract TradeSimulator {
    uint8 public constant OK = 0;
    uint8 public constant BUY_REVERTED = 1;
    uint8 public constant BUY_OUT_OF_GAS = 2;
    uint8 public constant SELL_REVERTED = 3;
    uint8 public constant SELL_OUT_OF_GAS = 4;

    uint8 public constant V2 = 0;
    uint8 public constant V3 = 1;
    uint8 public constant V4 = 2;

    /// Gas kept back from each leg for the work after it.
    uint256 private constant RESERVE = 100_000;
    /// The most one swap can carry: v4 accounts in int128.
    uint256 private constant MAX_AMOUNT = uint256(uint128(type(int128).max));
    uint160 private constant MIN_SQRT_PRICE = 4_295_128_739;
    uint160 private constant MAX_SQRT_PRICE = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342;

    /// One round trip. `pool` is the v2 pair, the v3 or Slipstream pool, or v4's PoolManager (with `key` naming the pool).
    /// `usdc` is the currency paid in: the USDC ERC-20, or address(0) for native USDC on v4. `amount` is in its units.
    struct Trade {
        uint8 kind;
        address pool;
        address token;
        address usdc;
        uint256 amount;
        ISimPoolManager.PoolKey key;
    }

    /// `spent` USDC bought `bought` tokens; selling `sold` of them brought `received` USDC back. All from balances.
    struct Result {
        uint8 status;
        uint256 spent;
        uint256 bought;
        uint256 sold;
        uint256 received;
    }

    /// The pool (v3) or PoolManager (v4) whose callback is expected during the current swap; nobody else's is honoured.
    address private _expected;

    receive() external payable {}

    function simulate(Trade calldata t) external returns (Result memory r) {
        (uint8 outcome, uint256 a, uint256 b) = _leg(abi.encodeCall(this.buy, (t)));
        if (outcome != OK) {
            r.status = outcome == LEG_REVERTED ? BUY_REVERTED : BUY_OUT_OF_GAS;
            return r;
        }
        (r.spent, r.bought) = (a, b);
        (outcome, a, b) = _leg(abi.encodeCall(this.sell, (t, r.bought)));
        if (outcome != OK) {
            r.status = outcome == LEG_REVERTED ? SELL_REVERTED : SELL_OUT_OF_GAS;
            return r;
        }
        (r.sold, r.received) = (a, b);
    }

    /// The buy leg: `t.amount` of USDC in. Only callable by this contract, from `simulate`.
    function buy(Trade calldata t) external returns (uint256 spent, uint256 bought) {
        require(msg.sender == address(this));
        uint256 usdcBefore = _balance(t.usdc);
        uint256 tokenBefore = _balance(t.token);
        _swap(t, t.usdc, t.token, t.amount);
        spent = _less(usdcBefore, _balance(t.usdc));
        bought = _less(_balance(t.token), tokenBefore);
    }

    /// The sell leg: `amount` of the token in. Only callable by this contract, from `simulate`.
    function sell(Trade calldata t, uint256 amount) external returns (uint256 sold, uint256 received) {
        require(msg.sender == address(this));
        if (amount == 0) return (0, 0);
        // A balance no pool could take in one swap (v4 counts in int128) is sold up to what one swap can carry.
        if (amount > MAX_AMOUNT) amount = MAX_AMOUNT;
        uint256 usdcBefore = _balance(t.usdc);
        uint256 tokenBefore = _balance(t.token);
        _swap(t, t.token, t.usdc, amount);
        sold = _less(tokenBefore, _balance(t.token));
        received = _less(_balance(t.usdc), usdcBefore);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        require(msg.sender == _expected && msg.sender != address(0));
        address tokenIn = abi.decode(data, (address));
        int256 owed = amount0Delta > 0 ? amount0Delta : amount1Delta;
        // casting to 'uint256' is safe because `owed` is positive here
        // forge-lint: disable-next-line(unsafe-typecast)
        if (owed > 0) _transfer(tokenIn, msg.sender, uint256(owed));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == _expected && msg.sender != address(0));
        (ISimPoolManager.PoolKey memory key, address currencyIn, address currencyOut, uint256 amountIn) =
            abi.decode(data, (ISimPoolManager.PoolKey, address, address, uint256));
        ISimPoolManager manager = ISimPoolManager(msg.sender);
        // Pay first, then swap exactly what the manager credited: a token that arrives short (a transfer tax) is then
        // sold for what arrived, as it is on v2, instead of leaving a debt that fails the whole unlock.
        uint256 paid;
        if (currencyIn == address(0)) {
            paid = manager.settle{value: amountIn}();
        } else {
            manager.sync(currencyIn);
            _transfer(currencyIn, address(manager), amountIn);
            paid = manager.settle();
        }
        if (paid == 0) return "";
        require(paid <= MAX_AMOUNT);
        bool zeroForOne = currencyIn == key.currency0;
        int256 delta = manager.swap(
            key,
            ISimPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                // casting to 'int256' is safe because `paid` is at most MAX_AMOUNT
                // forge-lint: disable-next-line(unsafe-typecast)
                amountSpecified: -int256(paid),
                sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE + 1 : MAX_SQRT_PRICE - 1
            }),
            ""
        );
        // casting to 'int128' is safe because a BalanceDelta is two int128s: this takes each half back out
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 amount0 = int256(int128(delta >> 128));
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 amount1 = int256(int128(delta));
        (int256 inDelta, int256 outDelta) = zeroForOne ? (amount0, amount1) : (amount1, amount0);
        // Whatever of the payment the swap didn't use is still a credit; take it back with the output.
        // casting to 'int256' is safe because `paid` is at most MAX_AMOUNT
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 unused = int256(paid) + inDelta;
        // casting to 'uint256' is safe because each is positive where it is cast
        // forge-lint: disable-next-line(unsafe-typecast)
        if (unused > 0) manager.take(currencyIn, address(this), uint256(unused));
        // forge-lint: disable-next-line(unsafe-typecast)
        if (outDelta > 0) manager.take(currencyOut, address(this), uint256(outDelta));
        return "";
    }

    // --- internals ---

    /// What a leg's self-call came to. Separate from the statuses above: `simulate` maps it to the leg's own.
    uint8 private constant LEG_REVERTED = 1;
    uint8 private constant LEG_OUT_OF_GAS = 2;

    /// Runs one leg as a call to this contract with a budget it can't exceed, and says how it ended. The budget is below
    /// the 63/64 a call may forward, so the leg gets all of it. A leg that used nearly all of it (15/16 or more) ran out of
    /// gas, itself or in a nested call (each level forwards 63/64 of what it has, so a few levels deep still uses more
    /// than 15/16): that says nothing about the token, so it is never read as a revert. Return data is copied only from
    /// a leg that succeeded (two words), so a token can't make the copy expensive.
    function _leg(bytes memory data) private returns (uint8 outcome, uint256 a, uint256 b) {
        uint256 start = gasleft();
        if (start <= 2 * RESERVE) return (LEG_OUT_OF_GAS, 0, 0);
        uint256 budget = start - start / 64 - RESERVE;
        bool ok;
        assembly ("memory-safe") {
            ok := call(budget, address(), 0, add(data, 0x20), mload(data), 0, 0)
            if and(ok, eq(returndatasize(), 64)) {
                let p := mload(0x40)
                returndatacopy(p, 0, 64)
                a := mload(p)
                b := mload(add(p, 32))
            }
        }
        if (ok) return (OK, a, b);
        return (start - gasleft() >= budget - budget / 16 ? LEG_OUT_OF_GAS : LEG_REVERTED, 0, 0);
    }

    function _swap(Trade calldata t, address tokenIn, address tokenOut, uint256 amountIn) private {
        if (t.kind == V2) {
            _swapV2(t.pool, tokenIn, amountIn);
        } else if (t.kind == V3) {
            _expected = t.pool;
            bool zeroForOne = tokenIn < tokenOut;
            ISimV3Pool(t.pool)
                .swap(
                    address(this),
                    zeroForOne,
                    // casting to 'int256' is safe because `sell` caps its amount at MAX_AMOUNT, and `buy` gets the
                    // caller's, which is small
                    // forge-lint: disable-next-line(unsafe-typecast)
                    int256(amountIn),
                    zeroForOne ? MIN_SQRT_PRICE + 1 : MAX_SQRT_PRICE - 1,
                    abi.encode(tokenIn)
                );
            _expected = address(0);
        } else if (t.kind == V4) {
            _expected = t.pool;
            ISimPoolManager(t.pool).unlock(abi.encode(t.key, tokenIn, tokenOut, amountIn));
            _expected = address(0);
        } else {
            revert();
        }
    }

    /// Pays the pair, then asks for what its reserves give for what actually arrived (the pair's balance over its
    /// reserve), at v2's 0.3% fee. Nothing arrived, or nothing to give for it: nothing is asked.
    function _swapV2(address pair, address tokenIn, uint256 amountIn) private {
        bool inIsToken0 = ISimV2Pair(pair).token0() == tokenIn;
        _transfer(tokenIn, pair, amountIn);
        (uint112 reserve0, uint112 reserve1,) = ISimV2Pair(pair).getReserves();
        (uint256 reserveIn, uint256 reserveOut) = inIsToken0 ? (reserve0, reserve1) : (reserve1, reserve0);
        uint256 arrived = _less(ISimERC20(tokenIn).balanceOf(pair), reserveIn);
        uint256 out = (arrived * 997 * reserveOut) / (reserveIn * 1000 + arrived * 997);
        if (out == 0) return;
        ISimV2Pair(pair).swap(inIsToken0 ? 0 : out, inIsToken0 ? out : 0, address(this), "");
    }

    /// `transfer`, accepting a token that returns nothing (as USDT does) and refusing one that returns false.
    function _transfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))));
    }

    /// This contract's balance of `currency`: native for address(0), the ERC-20's otherwise.
    function _balance(address currency) private view returns (uint256) {
        return currency == address(0) ? address(this).balance : ISimERC20(currency).balanceOf(address(this));
    }

    /// `a - b`, or 0 when `b` is larger: a balance that moved the wrong way counts as nothing moved, not as a revert.
    function _less(uint256 a, uint256 b) private pure returns (uint256) {
        return a > b ? a - b : 0;
    }
}
