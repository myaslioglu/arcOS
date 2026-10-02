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
/// one override funds both forms. Inspector draws a fresh random S for every call and sets the call's gas price to the
/// network's, so neither a known address nor a zero `tx.gasprice` gives the simulation away.
///
/// It swaps against the pool contracts directly: v2 through the pair's `swap`, v3 (and Aerodrome Slipstream) through
/// `swap` and its callback, v4 through `unlock` and its callback. The token reaches the pool on a sell the way a real
/// sell sends it, through `approve` and `transferFrom`: the same override puts a second copy of this code at another
/// random address R, the router, and on the sell leg S approves R for the amount and R pulls it from S into the pool
/// (`pull`). The buy pays USDC with a plain `transfer`.
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
    /// `router` is where the override put the second copy of this code, which moves the token on the sell leg.
    struct Trade {
        uint8 kind;
        address pool;
        address token;
        address usdc;
        address router;
        uint256 amount;
        ISimPoolManager.PoolKey key;
    }

    /// `spent` USDC bought `bought` tokens; selling `sold` of them brought `received` USDC back. All from balances, except
    /// `paidOut`: what the pool itself paid out on the buy (what the pair was asked for, or what the pool's swap reported),
    /// so a buy the pool paid for and the token never delivered can be told from one the pool paid nothing for.
    struct Result {
        uint8 status;
        uint256 spent;
        uint256 paidOut;
        uint256 bought;
        uint256 sold;
        uint256 received;
    }

    /// The pool (v3) or PoolManager (v4) whose callback is expected during the current swap; nobody else's is honoured.
    address private _expected;

    receive() external payable {}

    /// The round trip. Only callable by this contract: Inspector's call is from S to S.
    function simulate(Trade calldata t) external returns (Result memory r) {
        require(msg.sender == address(this));
        (uint8 outcome, uint256 a, uint256 b, uint256 c) = _leg(abi.encodeCall(this.buy, (t)), 3);
        if (outcome != OK) {
            r.status = outcome == LEG_REVERTED ? BUY_REVERTED : BUY_OUT_OF_GAS;
            return r;
        }
        (r.spent, r.paidOut, r.bought) = (a, b, c);
        (outcome, a, b,) = _leg(abi.encodeCall(this.sell, (t, r.bought)), 2);
        if (outcome != OK) {
            r.status = outcome == LEG_REVERTED ? SELL_REVERTED : SELL_OUT_OF_GAS;
            return r;
        }
        (r.sold, r.received) = (a, b);
    }

    /// The buy leg: `t.amount` of USDC in. Only callable by this contract, from `simulate`.
    function buy(Trade calldata t) external returns (uint256 spent, uint256 paidOut, uint256 bought) {
        require(msg.sender == address(this));
        uint256 usdcBefore = _balance(t.usdc);
        uint256 tokenBefore = _balance(t.token);
        paidOut = _swap(t, t.usdc, t.token, t.amount, address(0));
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
        _swap(t, t.token, t.usdc, amount, t.router);
        sold = _less(tokenBefore, _balance(t.token));
        received = _less(_balance(t.usdc), usdcBefore);
    }

    /// The router's half of a sell, run in the copy of this code at R: moves `amount` of `token` from the caller to `to`
    /// with `transferFrom`, as a DEX router does with what a seller approved. It only ever takes from its caller, so it can
    /// move nothing the caller didn't approve.
    function pull(address token, address to, uint256 amount) external {
        _call(token, abi.encodeWithSelector(0x23b872dd, msg.sender, to, amount));
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        require(msg.sender == _expected && msg.sender != address(0));
        (address tokenIn, address router) = abi.decode(data, (address, address));
        int256 owed = amount0Delta > 0 ? amount0Delta : amount1Delta;
        // casting to 'uint256' is safe because `owed` is positive here
        // forge-lint: disable-next-line(unsafe-typecast)
        if (owed > 0) _pay(tokenIn, msg.sender, uint256(owed), router);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == _expected && msg.sender != address(0));
        (
            ISimPoolManager.PoolKey memory key,
            address currencyIn,
            address currencyOut,
            uint256 amountIn,
            address router
        ) = abi.decode(data, (ISimPoolManager.PoolKey, address, address, uint256, address));
        ISimPoolManager manager = ISimPoolManager(msg.sender);
        // Pay first, then swap exactly what the manager credited: a token that arrives short (a transfer tax) is then
        // sold for what arrived, as it is on v2, instead of leaving a debt that fails the whole unlock.
        uint256 paid;
        if (currencyIn == address(0)) {
            paid = manager.settle{value: amountIn}();
        } else {
            manager.sync(currencyIn);
            _pay(currencyIn, address(manager), amountIn, router);
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
        if (outDelta <= 0) return "";
        // forge-lint: disable-next-line(unsafe-typecast)
        manager.take(currencyOut, address(this), uint256(outDelta));
        // What the pool paid out, for `buy` to report.
        // forge-lint: disable-next-line(unsafe-typecast)
        return abi.encode(uint256(outDelta));
    }

    // --- internals ---

    /// What a leg's self-call came to. Separate from the statuses above: `simulate` maps it to the leg's own.
    uint8 private constant LEG_REVERTED = 1;
    uint8 private constant LEG_OUT_OF_GAS = 2;

    /// Runs one leg as a call to this contract with a budget it can't exceed, and says how it ended. The budget is below
    /// the 63/64 a call may forward, so the leg gets all of it. A leg that used nearly all of it (7/8 or more) ran out of
    /// gas, itself or in a nested call: each level forwards 63/64 of what it has, and the deepest sell (v4: the leg, the
    /// PoolManager, the callback, the router, the token, and a contract the token calls) runs five levels down, where
    /// (63/64)^5 is still above 7/8. That says nothing about the token, so it is never read as a revert. Return data is
    /// copied only from a leg that succeeded (`words` words), so a token can't make the copy expensive.
    function _leg(bytes memory data, uint256 words) private returns (uint8 outcome, uint256 a, uint256 b, uint256 c) {
        uint256 start = gasleft();
        if (start <= 2 * RESERVE) return (LEG_OUT_OF_GAS, 0, 0, 0);
        uint256 budget = start - start / 64 - RESERVE;
        uint256 size = words * 32;
        bool ok;
        assembly ("memory-safe") {
            ok := call(budget, address(), 0, add(data, 0x20), mload(data), 0, 0)
            if and(ok, eq(returndatasize(), size)) {
                let p := mload(0x40)
                returndatacopy(p, 0, size)
                a := mload(p)
                b := mload(add(p, 32))
                if gt(size, 64) { c := mload(add(p, 64)) }
            }
        }
        if (ok) return (OK, a, b, c);
        return (start - gasleft() >= budget - budget / 8 ? LEG_OUT_OF_GAS : LEG_REVERTED, 0, 0, 0);
    }

    /// One swap of `amountIn` of `tokenIn`, paid directly (`router` is address(0)) or through the router. Returns what the
    /// pool paid out.
    function _swap(Trade calldata t, address tokenIn, address tokenOut, uint256 amountIn, address router)
        private
        returns (uint256 paidOut)
    {
        if (t.kind == V2) {
            paidOut = _swapV2(t.pool, tokenIn, amountIn, router, tokenIn == t.usdc);
        } else if (t.kind == V3) {
            _expected = t.pool;
            bool zeroForOne = tokenIn < tokenOut;
            (int256 amount0, int256 amount1) = ISimV3Pool(t.pool)
                .swap(
                    address(this),
                    zeroForOne,
                    // casting to 'int256' is safe because `sell` caps its amount at MAX_AMOUNT, and `buy` gets the
                    // caller's, which is small
                    // forge-lint: disable-next-line(unsafe-typecast)
                    int256(amountIn),
                    zeroForOne ? MIN_SQRT_PRICE + 1 : MAX_SQRT_PRICE - 1,
                    abi.encode(tokenIn, router)
                );
            _expected = address(0);
            int256 out = zeroForOne ? amount1 : amount0;
            // casting to 'uint256' is safe because `out` is negative where it is negated
            // forge-lint: disable-next-line(unsafe-typecast)
            paidOut = out < 0 ? uint256(-out) : 0;
        } else if (t.kind == V4) {
            _expected = t.pool;
            bytes memory ret = ISimPoolManager(t.pool).unlock(abi.encode(t.key, tokenIn, tokenOut, amountIn, router));
            _expected = address(0);
            if (ret.length == 32) paidOut = abi.decode(ret, (uint256));
        } else {
            revert();
        }
    }

    /// Asks the pair what its reserves give for `amountIn` before paying anything: a buy they give nothing for reverts
    /// (the buy leg is then unknown, not a round trip that lost everything), and a sell they give nothing for isn't sent.
    /// Then pays the pair, and asks for what its reserves, read again, give for what actually arrived (the pair's balance
    /// over its reserve), at v2's 0.3% fee: a token that swaps its tax as it moves changes the reserves on the way in, and a
    /// transfer tax shows as less arriving. Nothing to give for what arrived: nothing is asked. Returns what was asked.
    function _swapV2(address pair, address tokenIn, uint256 amountIn, address router, bool isBuy)
        private
        returns (uint256 out)
    {
        bool inIsToken0 = ISimV2Pair(pair).token0() == tokenIn;
        (uint256 reserveIn, uint256 reserveOut) = _reserves(pair, inIsToken0);
        if (_amountOut(amountIn, reserveIn, reserveOut) == 0) {
            require(!isBuy);
            return 0;
        }
        _pay(tokenIn, pair, amountIn, router);
        (reserveIn, reserveOut) = _reserves(pair, inIsToken0);
        out = _amountOut(_less(ISimERC20(tokenIn).balanceOf(pair), reserveIn), reserveIn, reserveOut);
        if (out == 0) return 0;
        ISimV2Pair(pair).swap(inIsToken0 ? 0 : out, inIsToken0 ? out : 0, address(this), "");
    }

    /// A v2 pair's reserves, the input side first.
    function _reserves(address pair, bool inIsToken0) private view returns (uint256 reserveIn, uint256 reserveOut) {
        (uint112 reserve0, uint112 reserve1,) = ISimV2Pair(pair).getReserves();
        (reserveIn, reserveOut) = inIsToken0 ? (reserve0, reserve1) : (reserve1, reserve0);
    }

    /// What a v2 pair pays for `amountIn`, at its 0.3% fee.
    function _amountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) private pure returns (uint256) {
        if (amountIn == 0) return 0;
        return (amountIn * 997 * reserveOut) / (reserveIn * 1000 + amountIn * 997);
    }

    /// Sends `amount` of `token` to `to`: with `transfer`, or, when a router is given, as a real sell does, by approving
    /// the router for it and having the router `transferFrom` it.
    function _pay(address token, address to, uint256 amount, address router) private {
        if (router == address(0)) return _transfer(token, to, amount);
        _call(token, abi.encodeWithSelector(0x095ea7b3, router, amount));
        TradeSimulator(payable(router)).pull(token, to, amount);
    }

    /// `transfer`, accepting a token that returns nothing (as USDT does) and refusing one that returns false.
    function _transfer(address token, address to, uint256 amount) private {
        _call(token, abi.encodeWithSelector(0xa9059cbb, to, amount));
    }

    /// Calls an ERC-20 function that returns a bool, accepting a token that returns nothing and refusing one that returns
    /// false.
    function _call(address token, bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
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
