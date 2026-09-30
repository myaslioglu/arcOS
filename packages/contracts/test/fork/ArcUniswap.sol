// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IV3PositionManager, IV4PositionManager} from "../../src/vault/interfaces/IPositionManagers.sol";

/// The Uniswap deployments on Arc mainnet that the fork tests drive, and the few calls the tests make on them beyond
/// what the vault itself uses. The two managers are Uniswap's deployments on Arc; the PoolManager and Permit2 are what
/// the v4 manager returns from `poolManager()` and `permit2()`.
library ArcUniswap {
    address internal constant V3_POSITION_MANAGER = 0x39654A85A4C05127f5Fd6ED22CAeC077A0fB1377;
    address internal constant V4_POSITION_MANAGER = 0x6049c9a0e26405C0985f9E3685C87d0aE917f82B;
    address internal constant V4_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    uint24 internal constant FEE = 3000; // 0.3%
    int24 internal constant TICK_SPACING = 60;
    int24 internal constant MAX_TICK = 887_220; // the widest range at tick spacing 60
    uint160 internal constant PRICE_ONE = 79_228_162_514_264_337_593_543_950_336; // sqrt(1) in Q64.96
    uint160 internal constant MIN_SQRT_PRICE = 4_295_128_739;
    uint160 internal constant MAX_SQRT_PRICE = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342;

    // v4-periphery Actions used by the tests themselves (the vault uses 0x01 and 0x11).
    uint8 internal constant DECREASE_LIQUIDITY = 0x01;
    uint8 internal constant MINT_POSITION = 0x02;
    uint8 internal constant BURN_POSITION = 0x03;
    uint8 internal constant SETTLE_PAIR = 0x0d;
    uint8 internal constant TAKE_PAIR = 0x11;
    uint8 internal constant SWEEP = 0x14;
}

interface IArcV3PositionManager is IV3PositionManager {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96)
        external
        payable
        returns (address pool);
    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    function decreaseLiquidity(DecreaseLiquidityParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1);
    function burn(uint256 tokenId) external payable;
    function approve(address to, uint256 tokenId) external;
    function getApproved(uint256 tokenId) external view returns (address);
    function setApprovalForAll(address operator, bool approved) external;
    function transferFrom(address from, address to, uint256 tokenId) external;
    function permit(address spender, uint256 tokenId, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external payable;
}

interface IArcV4PositionManager is IV4PositionManager {
    function poolManager() external view returns (address);
    function permit2() external view returns (address);
    function getPositionLiquidity(uint256 tokenId) external view returns (uint128);
    function nextTokenId() external view returns (uint256);
    function approve(address to, uint256 tokenId) external;
    function getApproved(uint256 tokenId) external view returns (address);
    function setApprovalForAll(address operator, bool approved) external;
    function transferFrom(address from, address to, uint256 tokenId) external;
    function permit(address spender, uint256 tokenId, uint256 deadline, uint256 nonce, bytes calldata signature)
        external
        payable;
}

interface IArcV4PoolManager {
    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
    }

    function initialize(IV4PositionManager.PoolKey memory key, uint160 sqrtPriceX96) external returns (int24 tick);
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(IV4PositionManager.PoolKey memory key, SwapParams memory params, bytes calldata hookData)
        external
        returns (int256 delta);
    function sync(address currency) external;
    function settle() external payable returns (uint256 paid);
    function take(address currency, address to, uint256 amount) external;
}

interface IArcV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata)
        external
        returns (int256 amount0, int256 amount1);
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// Trades against the fork's pools so that positions earn fees: exact-input swaps on a v3 pool (through its callback)
/// and on a v4 pool (through the PoolManager's unlock callback). It pays from its own balances, so fund it first.
contract ForkSwapper {
    IArcV4PoolManager internal constant POOL_MANAGER = IArcV4PoolManager(ArcUniswap.V4_POOL_MANAGER);

    receive() external payable {}

    function swapV3(IArcV3Pool pool, bool zeroForOne, uint256 amountIn) external {
        uint160 limit = zeroForOne ? ArcUniswap.MIN_SQRT_PRICE + 1 : ArcUniswap.MAX_SQRT_PRICE - 1;
        // forge-lint: disable-next-line(unsafe-typecast)
        pool.swap(address(this), zeroForOne, int256(amountIn), limit, abi.encode(pool.token0(), pool.token1()));
    }

    function uniswapV3SwapCallback(int256 amount0, int256 amount1, bytes calldata data) external {
        (address token0, address token1) = abi.decode(data, (address, address));
        // forge-lint: disable-next-line(unsafe-typecast)
        if (amount0 > 0) require(IERC20(token0).transfer(msg.sender, uint256(amount0)), "pay token0");
        // forge-lint: disable-next-line(unsafe-typecast)
        if (amount1 > 0) require(IERC20(token1).transfer(msg.sender, uint256(amount1)), "pay token1");
    }

    function swapV4(IV4PositionManager.PoolKey calldata key, bool zeroForOne, uint256 amountIn) external {
        POOL_MANAGER.unlock(abi.encode(key, zeroForOne, amountIn));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(POOL_MANAGER), "not the pool manager");
        (IV4PositionManager.PoolKey memory key, bool zeroForOne, uint256 amountIn) =
            abi.decode(data, (IV4PositionManager.PoolKey, bool, uint256));
        uint160 limit = zeroForOne ? ArcUniswap.MIN_SQRT_PRICE + 1 : ArcUniswap.MAX_SQRT_PRICE - 1;
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 delta = POOL_MANAGER.swap(key, IArcV4PoolManager.SwapParams(zeroForOne, -int256(amountIn), limit), "");
        // A BalanceDelta packs amount0 in the upper 128 bits and amount1 in the lower 128.
        // forge-lint: disable-next-line(unsafe-typecast)
        _resolve(key.currency0, int128(delta >> 128));
        // forge-lint: disable-next-line(unsafe-typecast)
        _resolve(key.currency1, int128(delta));
        return "";
    }

    function _resolve(address currency, int128 delta) private {
        if (delta < 0) {
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256 owed = uint256(uint128(-delta));
            POOL_MANAGER.sync(currency);
            if (currency == address(0)) {
                POOL_MANAGER.settle{value: owed}();
            } else {
                require(IERC20(currency).transfer(address(POOL_MANAGER), owed), "pay");
                POOL_MANAGER.settle();
            }
        } else if (delta > 0) {
            // forge-lint: disable-next-line(unsafe-typecast)
            POOL_MANAGER.take(currency, address(this), uint256(uint128(delta)));
        }
    }
}
