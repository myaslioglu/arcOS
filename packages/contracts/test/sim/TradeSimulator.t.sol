// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {TradeSimulator, ISimPoolManager} from "../../src/sim/TradeSimulator.sol";
import {
    SimToken,
    SimTrapToken,
    GasSink,
    MockV2Pair,
    MockV3Pool,
    MockPoolManager,
    PermissiveManager
} from "./SimMocks.sol";

/// The simulator against mock v2, v3 and v4 pools: an honest token, a transfer tax, a sell block, a blacklist, a sell
/// that burns its gas (itself or in a contract it calls), a `transferFrom` that reverts, and a dynamic fee. The USDC here
/// is a 6-decimal mock (a fork can't move Arc's 0x3600 USDC; the live eth_call suite covers that path), and native USDC is
/// the test chain's ether.
contract TradeSimulatorTest is Test {
    /// Where Inspector places the code with its state override (a fresh random address on every run; these are two).
    address internal constant S = 0x7c3f9A51d2E84B06a1c95e3d7b28F04c6A9E1D53;
    /// The router: a second copy of the code, in the same override.
    address internal constant R = 0x2b9E64C1f07A3d85E4b1C6A9d03f7e52b8c41a96;
    uint256 internal constant AMOUNT = 10e6; // 10 USDC
    uint24 internal constant DYNAMIC_FEE = 0x800000; // v4's dynamic-fee flag

    SimToken internal usdc;
    SimTrapToken internal token;
    TradeSimulator internal sim;

    function setUp() public {
        usdc = new SimToken("USDC", 6);
        token = new SimTrapToken();
        // As in the eth_call: the runtime code placed at S, which holds the USDC it trades with.
        vm.etch(S, type(TradeSimulator).runtimeCode);
        vm.etch(R, type(TradeSimulator).runtimeCode);
        sim = TradeSimulator(payable(S));
        usdc.mint(S, AMOUNT);
    }

    // --- helpers ---

    function _v2() internal returns (MockV2Pair pair) {
        pair = new MockV2Pair(address(usdc), address(token));
        usdc.mint(address(pair), 10_000e6);
        token.seed(address(pair), 1_000_000e18);
        pair.sync();
        token.setPool(address(pair));
    }

    function _v3(uint24 fee) internal returns (MockV3Pool pool) {
        pool = new MockV3Pool(address(usdc), address(token), fee);
        usdc.mint(address(pool), 10_000e6);
        token.seed(address(pool), 1_000_000e18);
        token.setPool(address(pool));
    }

    function _key(address quote, uint24 fee) internal view returns (ISimPoolManager.PoolKey memory key) {
        (address c0, address c1) = quote < address(token) ? (quote, address(token)) : (address(token), quote);
        key = ISimPoolManager.PoolKey({currency0: c0, currency1: c1, fee: fee, tickSpacing: 60, hooks: address(0)});
    }

    /// A v4 pool of the token against `quote` (address(0) for native), seeded with 10,000 USDC and 1,000,000 tokens.
    function _v4(address quote, uint24 fee)
        internal
        returns (MockPoolManager manager, ISimPoolManager.PoolKey memory key)
    {
        manager = new MockPoolManager();
        key = _key(quote, fee);
        uint256 quoteSeed = quote == address(0) ? 10_000e18 : 10_000e6;
        if (quote == address(0)) vm.deal(address(manager), quoteSeed);
        else usdc.mint(address(manager), quoteSeed);
        token.seed(address(manager), 1_000_000e18);
        (uint256 a0, uint256 a1) =
            key.currency0 == quote ? (quoteSeed, uint256(1_000_000e18)) : (uint256(1_000_000e18), quoteSeed);
        manager.seed(key, a0, a1);
        token.setPool(address(manager));
    }

    function _trade(uint8 kind, address pool, address quote, uint256 amount, ISimPoolManager.PoolKey memory key)
        internal
        view
        returns (TradeSimulator.Trade memory)
    {
        return TradeSimulator.Trade({
            kind: kind,
            pool: pool,
            token: address(token),
            usdc: quote,
            router: R,
            amount: amount,
            maxAmount: amount * 100,
            key: key
        });
    }

    function _noKey() internal pure returns (ISimPoolManager.PoolKey memory key) {}

    /// The call as Inspector makes it: from S to S, so tx.origin is the caller.
    function _run(TradeSimulator.Trade memory t, uint256 gas) internal returns (TradeSimulator.Result memory) {
        vm.prank(S, S);
        return sim.simulate{gas: gas}(t);
    }

    /// The loss of a round trip in parts per million of what was spent.
    function _lossPpm(TradeSimulator.Result memory r) internal pure returns (uint256) {
        return r.received >= r.spent ? 0 : ((r.spent - r.received) * 1e6) / r.spent;
    }

    // --- v2 ---

    function test_v2_honestTokenLosesOnlyTheFees() public {
        MockV2Pair pair = _v2();
        TradeSimulator.Result memory r =
            _run(_trade(sim.V2(), address(pair), address(usdc), AMOUNT, _noKey()), 5_000_000);
        assertEq(r.status, sim.OK());
        assertEq(r.spent, AMOUNT);
        assertGt(r.bought, 0);
        assertEq(r.paidOut, r.bought);
        assertEq(r.sold, r.bought);
        // Two 0.3% fees: about 0.6%, and nothing more.
        assertApproxEqAbs(_lossPpm(r), 6_000, 100);
        _assertSoldThroughTheRouter();
    }

    /// The sell went in as a real one does: S approved R, and R's `transferFrom` used all of it.
    function _assertSoldThroughTheRouter() internal view {
        assertEq(token.transferFroms(), 1);
        assertEq(token.allowance(S, R), 0);
    }

    function test_v2_transferTaxShowsInTheLoss() public {
        MockV2Pair pair = _v2();
        token.setTaxes(500, 500); // 5% on the buy, 5% on the sell
        TradeSimulator.Result memory r =
            _run(_trade(sim.V2(), address(pair), address(usdc), AMOUNT, _noKey()), 5_000_000);
        assertEq(r.status, sim.OK());
        // 1 - 0.95 * 0.95 * 0.997^2, about 10.3%.
        assertApproxEqAbs(_lossPpm(r), 103_000, 1_000);
    }

    function test_v2_sellBlockIsASellRevert() public {
        MockV2Pair pair = _v2();
        token.setSellBlocked(true);
        TradeSimulator.Result memory r =
            _run(_trade(sim.V2(), address(pair), address(usdc), AMOUNT, _noKey()), 5_000_000);
        assertEq(r.status, sim.SELL_REVERTED());
        assertEq(r.spent, AMOUNT);
        assertGt(r.bought, 0);
        assertEq(r.received, 0);
    }

    function test_v2_blacklistedBuyerIsASellRevert() public {
        MockV2Pair pair = _v2();
        token.setBlacklistBuyers(true);
        TradeSimulator.Result memory r =
            _run(_trade(sim.V2(), address(pair), address(usdc), AMOUNT, _noKey()), 5_000_000);
        assertEq(r.status, sim.SELL_REVERTED());
    }

    function test_v2_aSellThatBurnsAllItsGasIsOutOfGasNotARevert() public {
        MockV2Pair pair = _v2();
        token.setBurnGasOnSell(true);
        TradeSimulator.Result memory r =
            _run(_trade(sim.V2(), address(pair), address(usdc), AMOUNT, _noKey()), 5_000_000);
        assertEq(r.status, sim.SELL_OUT_OF_GAS());
    }

    function test_v2_aHundredPercentBuyTaxBuysNothingAndSellsNothing() public {
        MockV2Pair pair = _v2();
        token.setTaxes(10_000, 0);
        TradeSimulator.Result memory r =
            _run(_trade(sim.V2(), address(pair), address(usdc), AMOUNT, _noKey()), 5_000_000);
        assertEq(r.status, sim.OK());
        assertEq(r.spent, AMOUNT);
        // The pair paid out; the token delivered nothing of it.
        assertGt(r.paidOut, 0);
        assertEq(r.bought, 0);
        assertEq(r.received, 0);
    }

    function test_v2_aPairThatGivesNothingForTheBuyIsAPoolThatCantTrade() public {
        // A pair holding one token unit: 10 USDC buys nothing of it, which the pair's reserves say before anything is sent.
        MockV2Pair pair = new MockV2Pair(address(usdc), address(token));
        usdc.mint(address(pair), 10_000e6);
        token.seed(address(pair), 1);
        pair.sync();
        token.setPool(address(pair));
        TradeSimulator.Result memory r =
            _run(_trade(sim.V2(), address(pair), address(usdc), AMOUNT, _noKey()), 5_000_000);
        assertEq(r.status, sim.POOL_CANT_TRADE());
        assertEq(r.spent, 0);
        assertEq(usdc.balanceOf(S), AMOUNT);
    }

    function test_v2_aSellWhoseTransferFromRevertsIsASellRevert() public {
        MockV2Pair pair = _v2();
        token.setTransferFromBlocked(true);
        TradeSimulator.Result memory r =
            _run(_trade(sim.V2(), address(pair), address(usdc), AMOUNT, _noKey()), 5_000_000);
        assertEq(r.status, sim.SELL_REVERTED());
        assertGt(r.bought, 0);
    }

    function test_v2_aSellThatRunsAContractOutOfGasIsOutOfGasNotARevert() public {
        MockV2Pair pair = _v2();
        token.setGasSink(address(new GasSink()));
        TradeSimulator.Result memory r =
            _run(_trade(sim.V2(), address(pair), address(usdc), AMOUNT, _noKey()), 5_000_000);
        assertEq(r.status, sim.SELL_OUT_OF_GAS());
    }

    // --- v3 ---

    function test_v3_honestTokenLosesOnlyTheFees() public {
        MockV3Pool pool = _v3(3000);
        TradeSimulator.Result memory r =
            _run(_trade(sim.V3(), address(pool), address(usdc), AMOUNT, _noKey()), 5_000_000);
        assertEq(r.status, sim.OK());
        assertEq(r.spent, AMOUNT);
        assertEq(r.paidOut, r.bought);
        assertEq(r.sold, r.bought);
        assertApproxEqAbs(_lossPpm(r), 6_000, 100);
        assertEq(pool.calls(), 2);
        _assertSoldThroughTheRouter();
    }

    function test_v3_aSellWhoseTransferFromRevertsIsASellRevert() public {
        MockV3Pool pool = _v3(3000);
        token.setTransferFromBlocked(true);
        TradeSimulator.Result memory r =
            _run(_trade(sim.V3(), address(pool), address(usdc), AMOUNT, _noKey()), 5_000_000);
        assertEq(r.status, sim.SELL_REVERTED());
        assertGt(r.bought, 0);
    }

    function test_v3_aSellThatRunsAContractOutOfGasIsOutOfGasNotARevert() public {
        MockV3Pool pool = _v3(3000);
        token.setGasSink(address(new GasSink()));
        TradeSimulator.Result memory r =
            _run(_trade(sim.V3(), address(pool), address(usdc), AMOUNT, _noKey()), 5_000_000);
        assertEq(r.status, sim.SELL_OUT_OF_GAS());
    }

    function test_v3_aTokenThatArrivesShortCantBeSoldIntoTheSamePool() public {
        MockV3Pool pool = _v3(3000);
        token.setTaxes(0, 500);
        TradeSimulator.Result memory r =
            _run(_trade(sim.V3(), address(pool), address(usdc), AMOUNT, _noKey()), 5_000_000);
        assertEq(r.status, sim.SELL_REVERTED());
    }

    function test_v3_sellBlockIsASellRevert() public {
        MockV3Pool pool = _v3(500);
        token.setSellBlocked(true);
        TradeSimulator.Result memory r =
            _run(_trade(sim.V3(), address(pool), address(usdc), AMOUNT, _noKey()), 5_000_000);
        assertEq(r.status, sim.SELL_REVERTED());
    }

    function test_v3_callbackRefusesAnyoneButThePoolBeingSwapped() public {
        vm.expectRevert();
        sim.uniswapV3SwapCallback(1, 0, abi.encode(address(usdc), address(0)));
        assertEq(usdc.balanceOf(S), AMOUNT);
    }

    function test_v3_aPoolWithNoPriceOrAtItsPriceLimitIsAPoolThatCantTrade() public {
        MockV3Pool pool = _v3(3000);
        bool usdcIsToken0 = address(usdc) < address(token);
        // Buying the token moves the price toward the limit on the USDC side.
        uint160 atLimit =
            usdcIsToken0 ? 4_295_128_740 : 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341;
        uint160[2] memory prices = [atLimit, 0];
        for (uint256 i; i < 2; i++) {
            pool.setState(prices[i], 1e18);
            TradeSimulator.Result memory r =
                _run(_trade(sim.V3(), address(pool), address(usdc), AMOUNT, _noKey()), 5_000_000);
            assertEq(r.status, sim.POOL_CANT_TRADE());
            assertEq(usdc.balanceOf(S), AMOUNT);
        }
    }

    function test_v3_aPoolWithNoActiveLiquidityIsStillTraded() public {
        // A single-sided launch pool sits outside its range with no liquidity active; a buy moves the price into it.
        MockV3Pool pool = _v3(3000);
        pool.setState(uint160(1 << 96), 0);
        TradeSimulator.Result memory r =
            _run(_trade(sim.V3(), address(pool), address(usdc), AMOUNT, _noKey()), 5_000_000);
        assertEq(r.status, sim.OK());
    }

    function test_v3_aBuyTheTokenRefusesIsABuyRevertNotAPoolThatCantTrade() public {
        MockV3Pool pool = _v3(3000);
        token.setBlockContractBuyers(true);
        TradeSimulator.Result memory r =
            _run(_trade(sim.V3(), address(pool), address(usdc), AMOUNT, _noKey()), 5_000_000);
        assertEq(r.status, sim.BUY_REVERTED());
    }

    function test_v2_aBuyTheTokenRefusesIsABuyRevertNotAPoolThatCantTrade() public {
        MockV2Pair pair = _v2();
        token.setBlockContractBuyers(true);
        TradeSimulator.Result memory r =
            _run(_trade(sim.V2(), address(pair), address(usdc), AMOUNT, _noKey()), 5_000_000);
        assertEq(r.status, sim.BUY_REVERTED());
    }

    /// A v3 pool of a token with no decimals: 1,000 raw units against 10,000 USDC, 10 USDC a unit, its price set to match.
    function _v3FewUnits() internal returns (MockV3Pool pool) {
        pool = new MockV3Pool(address(usdc), address(token), 3000);
        usdc.mint(address(pool), 10_000e6);
        token.seed(address(pool), 1000);
        token.setPool(address(pool));
        // sqrt(token1 / token0) in Q64.96: 1e-7 when USDC is token0, 1e7 when it is token1.
        pool.setState(
            address(usdc) < address(token)
                ? 25_054_144_837_504_793_118_641_380
                : 250_541_448_375_047_931_186_413_801_569_606,
            1e18
        );
    }

    function _fewUnitsTrade(MockV3Pool pool, uint256 maxAmount) internal view returns (TradeSimulator.Trade memory t) {
        t = _trade(sim.V3(), address(pool), address(usdc), 10_000, _noKey()); // 0.01 USDC: less than one unit
        t.maxAmount = maxAmount;
    }

    function test_v3_aTokenWithFewUnitsIsBoughtWithEnoughForWholeUnits() public {
        MockV3Pool pool = _v3FewUnits();
        usdc.mint(S, 100e6);
        TradeSimulator.Result memory r = _run(_fewUnitsTrade(pool, 100e6), 5_000_000);
        assertEq(r.status, sim.OK());
        // Raised to the 100 USDC limit (100 units would cost 1,000): about 9.9 units, 9 whole.
        assertEq(r.spent, 100e6);
        assertGt(r.paidOut, 0);
        assertEq(r.bought, r.paidOut);
        assertEq(r.sold, r.bought);
        assertGt(r.received, 0);
    }

    function test_v3_aTokenWhoseUnitCostsMoreThanTheLimitIsNotBought() public {
        MockV3Pool pool = _v3FewUnits();
        // Two units cost 20 USDC, over a 15 USDC limit.
        TradeSimulator.Result memory r = _run(_fewUnitsTrade(pool, 15e6), 5_000_000);
        assertEq(r.status, sim.AMOUNT_OVER_LIMIT());
        assertEq(r.spent, 0);
        assertEq(usdc.balanceOf(S), AMOUNT);
    }

    function test_aNormalTokenIsBoughtWithTheTestAmount() public {
        MockV3Pool pool = _v3(3000);
        TradeSimulator.Result memory r =
            _run(_trade(sim.V3(), address(pool), address(usdc), AMOUNT, _noKey()), 5_000_000);
        assertEq(r.spent, AMOUNT);
    }

    // --- v4 ---

    function test_v4_aPoolAtItsPriceLimitIsAPoolThatCantTrade() public {
        (MockPoolManager manager, ISimPoolManager.PoolKey memory key) = _v4(address(usdc), 3000);
        bool zeroForOne = key.currency0 == address(usdc);
        manager.setState(
            key, zeroForOne ? 4_295_128_740 : 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341, 1e18
        );
        TradeSimulator.Result memory r = _run(_trade(sim.V4(), address(manager), address(usdc), AMOUNT, key), 5_000_000);
        assertEq(r.status, sim.POOL_CANT_TRADE());
    }

    function test_v4_aBuyTheTokenRefusesIsABuyRevertNotAPoolThatCantTrade() public {
        (MockPoolManager manager, ISimPoolManager.PoolKey memory key) = _v4(address(usdc), 3000);
        token.setBlockContractBuyers(true);
        TradeSimulator.Result memory r = _run(_trade(sim.V4(), address(manager), address(usdc), AMOUNT, key), 5_000_000);
        assertEq(r.status, sim.BUY_REVERTED());
    }

    function test_v4_nativeUsdcHonestToken() public {
        (MockPoolManager manager, ISimPoolManager.PoolKey memory key) = _v4(address(0), 3000);
        vm.deal(S, 10e18); // 10 native USDC, 18 decimals
        TradeSimulator.Result memory r = _run(_trade(sim.V4(), address(manager), address(0), 10e18, key), 5_000_000);
        assertEq(r.status, sim.OK());
        assertEq(r.spent, 10e18);
        assertEq(r.paidOut, r.bought);
        assertEq(r.sold, r.bought);
        assertApproxEqAbs(_lossPpm(r), 6_000, 100);
        _assertSoldThroughTheRouter();
    }

    function test_v4_aSellWhoseTransferFromRevertsIsASellRevert() public {
        (MockPoolManager manager, ISimPoolManager.PoolKey memory key) = _v4(address(usdc), 3000);
        token.setTransferFromBlocked(true);
        TradeSimulator.Result memory r = _run(_trade(sim.V4(), address(manager), address(usdc), AMOUNT, key), 5_000_000);
        assertEq(r.status, sim.SELL_REVERTED());
        assertGt(r.bought, 0);
    }

    function test_v4_aSellThatRunsAContractOutOfGasIsOutOfGasNotARevert() public {
        (MockPoolManager manager, ISimPoolManager.PoolKey memory key) = _v4(address(usdc), 3000);
        token.setGasSink(address(new GasSink()));
        TradeSimulator.Result memory r = _run(_trade(sim.V4(), address(manager), address(usdc), AMOUNT, key), 5_000_000);
        assertEq(r.status, sim.SELL_OUT_OF_GAS());
    }

    function test_v4_erc20UsdcTransferTaxIsSoldForWhatArrived() public {
        (MockPoolManager manager, ISimPoolManager.PoolKey memory key) = _v4(address(usdc), 3000);
        token.setTaxes(300, 300);
        TradeSimulator.Result memory r = _run(_trade(sim.V4(), address(manager), address(usdc), AMOUNT, key), 5_000_000);
        assertEq(r.status, sim.OK());
        // The manager paid out the full amount; 3% of it went to the tax wallet on the way.
        assertApproxEqAbs(r.bought, (r.paidOut * 97) / 100, 1);
        // 1 - 0.97 * 0.97 * 0.997^2, about 6.5%.
        assertApproxEqAbs(_lossPpm(r), 64_500, 1_000);
    }

    function test_v4_dynamicFeeShowsInTheLoss() public {
        (MockPoolManager manager, ISimPoolManager.PoolKey memory key) = _v4(address(usdc), DYNAMIC_FEE);
        manager.setDynamicFee(100_000); // 10%
        TradeSimulator.Result memory r = _run(_trade(sim.V4(), address(manager), address(usdc), AMOUNT, key), 5_000_000);
        assertEq(r.status, sim.OK());
        // 1 - 0.9^2: 19%.
        assertApproxEqAbs(_lossPpm(r), 190_000, 1_000);
    }

    function test_v4_sellBlockIsASellRevert() public {
        (MockPoolManager manager, ISimPoolManager.PoolKey memory key) = _v4(address(usdc), 3000);
        token.setSellBlocked(true);
        TradeSimulator.Result memory r = _run(_trade(sim.V4(), address(manager), address(usdc), AMOUNT, key), 5_000_000);
        assertEq(r.status, sim.SELL_REVERTED());
        assertGt(r.bought, 0);
    }

    function test_v4_blacklistedBuyerIsASellRevert() public {
        (MockPoolManager manager, ISimPoolManager.PoolKey memory key) = _v4(address(0), 3000);
        vm.deal(S, 10e18);
        token.setBlacklistBuyers(true);
        TradeSimulator.Result memory r = _run(_trade(sim.V4(), address(manager), address(0), 10e18, key), 5_000_000);
        assertEq(r.status, sim.SELL_REVERTED());
    }

    function test_v4_aPoolWithNoPriceOrLiquidityIsAPoolThatCantTrade() public {
        MockPoolManager manager = new MockPoolManager();
        token.setPool(address(manager));
        TradeSimulator.Result memory r =
            _run(_trade(sim.V4(), address(manager), address(usdc), AMOUNT, _key(address(usdc), 3000)), 5_000_000);
        assertEq(r.status, sim.POOL_CANT_TRADE());
        assertEq(r.spent, 0);
        assertEq(usdc.balanceOf(S), AMOUNT);
    }

    /// The caller answers every call the callback makes, so only the guard stops it being paid: this fails without it.
    function test_v4_unlockCallbackRefusesAnyoneButTheManagerBeingSwapped() public {
        PermissiveManager impostor = new PermissiveManager();
        bytes memory data = abi.encode(_key(address(usdc), 3000), address(usdc), address(token), AMOUNT, address(0));
        vm.expectRevert();
        impostor.attack(S, data);
        assertEq(usdc.balanceOf(S), AMOUNT);
        assertEq(usdc.balanceOf(address(impostor)), 0);
    }

    // --- the call itself ---

    function test_anUnknownKindIsABuyRevertNotARevertOfTheCall() public {
        MockV2Pair pair = _v2();
        TradeSimulator.Result memory r = _run(_trade(7, address(pair), address(usdc), AMOUNT, _noKey()), 5_000_000);
        assertEq(r.status, sim.BUY_REVERTED());
    }

    function test_simulateIsOnlyCallableByTheSimulatorItself() public {
        MockV2Pair pair = _v2();
        TradeSimulator.Trade memory t = _trade(sim.V2(), address(pair), address(usdc), AMOUNT, _noKey());
        vm.expectRevert();
        sim.simulate(t);
        assertEq(usdc.balanceOf(S), AMOUNT);
    }

    function test_theRouterOnlyMovesWhatItsCallerApproved() public {
        // S has approved R, as on a sell; R still pulls from its caller only, so a third party asking it can't touch S's
        // tokens or use S's allowance.
        token.seed(S, 1e18);
        vm.prank(S);
        token.approve(R, 1e18);
        address thirdParty = makeAddr("thirdParty");
        vm.prank(thirdParty);
        vm.expectRevert();
        TradeSimulator(payable(R)).pull(address(token), thirdParty, 1e18);
        assertEq(token.balanceOf(S), 1e18);
        assertEq(token.balanceOf(thirdParty), 0);
        assertEq(token.allowance(S, R), 1e18);
    }

    function test_theLegsAreOnlyCallableByTheSimulatorItself() public {
        MockV2Pair pair = _v2();
        TradeSimulator.Trade memory t = _trade(sim.V2(), address(pair), address(usdc), AMOUNT, _noKey());
        vm.expectRevert();
        sim.buy(t, AMOUNT);
        vm.expectRevert();
        sim.sell(t, 1);
    }

    function test_tooLittleGasForALegIsOutOfGas() public {
        MockV2Pair pair = _v2();
        TradeSimulator.Result memory r = _run(_trade(sim.V2(), address(pair), address(usdc), AMOUNT, _noKey()), 150_000);
        assertEq(r.status, sim.BUY_OUT_OF_GAS());
    }
}
