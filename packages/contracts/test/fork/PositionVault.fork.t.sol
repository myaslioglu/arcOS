// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {FeeController} from "../../src/FeeController.sol";
import {PositionVault} from "../../src/vault/PositionVault.sol";
import {VaultFactory} from "../../src/vault/VaultFactory.sol";
import {IV3PositionManager, IV4PositionManager} from "../../src/vault/interfaces/IPositionManagers.sol";
import {MockToken} from "../vault/mocks/VaultMocks.sol";
import {
    ArcUniswap,
    ForkSwapper,
    IArcV3Pool,
    IArcV3PositionManager,
    IArcV4PoolManager,
    IArcV4PositionManager,
    IPermit2
} from "./ArcUniswap.sol";

/// PositionVault against the real Uniswap v3 NonfungiblePositionManager and v4 PositionManager, on a fork of Arc
/// mainnet at a pinned block. Out of the default run (`foundry.toml`), because it needs the network:
///
///     cd packages/contracts && npm run test:fork   (FOUNDRY_PROFILE=fork node scripts/forge.mjs test -vv)
///
/// A fork cannot move USDC at `0x3600` (its balances live behind precompiles the fork lacks), so every pool here
/// is made of fresh mock tokens, plus a v4 pool against the native currency; each flow also checks that nothing it did
/// touched `0x3600`. The factory, fee controller and vault implementation are deployed on the fork; the managers and
/// the v4 PoolManager are the deployed ones.
///
/// What it proves on the real managers: a lock pulls the position into its vault; swaps earn fees; `collect` takes
/// them all and splits them at the share copied at creation, with the liquidity untouched (so the v4 action bytes and
/// their encoding are the deployed PositionManager's); every early exit fails (withdraw, decrease, burn, collect
/// around the vault, transfer, approve, permit); and after `unlockAt` the owner gets a position that works.
/// The gas of each entry point on the real managers is logged with `-vv`.
contract PositionVaultForkTest is Test {
    using SafeCast for uint256;

    uint256 internal constant FORK_BLOCK = 23_450_000;
    uint256 internal constant ARC_MAINNET = 5042;
    address internal constant USDC = 0x3600000000000000000000000000000000000000;

    uint256 internal constant FLAT = 30 ether;
    uint256 internal constant SHARE_BPS = 200;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant DEPOSIT = 1_000 ether; // of each currency, per position
    uint128 internal constant V4_LIQUIDITY = 1_000 ether;
    uint256 internal constant SWAP = 100 ether; // per direction, per pool
    uint256 internal constant INTRINSIC = 21_000;
    // The v3 manager's ERC-721 (OpenZeppelin 3) refuses a transfer by anyone but the owner or an approved address so.
    string internal constant V3_NOT_APPROVED = "ERC721: transfer caller is not owner nor approved";

    IArcV3PositionManager internal constant V3 = IArcV3PositionManager(ArcUniswap.V3_POSITION_MANAGER);
    IArcV4PositionManager internal constant V4 = IArcV4PositionManager(ArcUniswap.V4_POSITION_MANAGER);

    address internal feeOwner = makeAddr("feeOwner");
    address payable internal feeRecipient = payable(makeAddr("feeRecipient"));
    address internal factoryOwner = makeAddr("factoryOwner");
    Vm.Wallet internal aliceWallet = vm.createWallet("alice");
    address internal alice = aliceWallet.addr;
    address internal bob = makeAddr("bob");
    address internal stranger = makeAddr("stranger");

    FeeController internal fees;
    VaultFactory internal factory;
    ForkSwapper internal swapper;
    address internal token0; // the two mock tokens, sorted
    address internal token1;
    IArcV3Pool internal v3Pool;
    IV4PositionManager.PoolKey internal erc20Key; // token0 / token1
    IV4PositionManager.PoolKey internal nativeKey; // native / token0

    // Locked in setUp, with fees accrued since, so each test (and each gas figure) starts from cold storage.
    uint256 internal v3Id;
    uint256 internal v4Id;
    uint256 internal nativeId;
    PositionVault internal v3Vault;
    PositionVault internal v4Vault;
    PositionVault internal nativeVault;
    PositionVault internal handOverVault; // a fourth lock (v3), with bob as its pending owner: for the gas figure
    uint64 internal unlockAt;
    // Minted and approved to the factory in setUp, never locked: for the lockPosition gas figures.
    uint256 internal freshV3Id;
    uint256 internal freshV4Id;
    uint256 internal freshNativeId;
    // Alice's own v4 position, never locked: for the action-byte check.
    uint256 internal unlockedV4Id;

    function setUp() public {
        vm.createSelectFork("arc", FORK_BLOCK);
        assertEq(block.chainid, ARC_MAINNET);
        assertEq(V4.poolManager(), ArcUniswap.V4_POOL_MANAGER);
        assertEq(V4.permit2(), ArcUniswap.PERMIT2);

        fees = new FeeController(feeOwner, feeRecipient);
        vm.startPrank(feeOwner);
        fees.addKey(keccak256("LOCK_FLAT"), FLAT, 150 ether);
        fees.addKey(keccak256("LOCK_LP_BPS"), 50, 100);
        fees.addKey(keccak256("LOCK_FEE_SHARE_BPS"), SHARE_BPS, 500);
        vm.stopPrank();
        factory = new VaultFactory(factoryOwner, fees);
        vm.startPrank(factoryOwner);
        factory.setManager(address(V3), true, PositionVault.Kind.V3);
        factory.setManager(address(V4), true, PositionVault.Kind.V4);
        vm.stopPrank();

        (address a, address b) = (address(new MockToken()), address(new MockToken()));
        (token0, token1) = a < b ? (a, b) : (b, a);
        swapper = new ForkSwapper();
        _fund(alice);
        _fund(address(swapper));

        v3Pool = IArcV3Pool(V3.createAndInitializePoolIfNecessary(token0, token1, ArcUniswap.FEE, ArcUniswap.PRICE_ONE));
        erc20Key = _key(token0, token1);
        nativeKey = _key(address(0), token0);
        IArcV4PoolManager(ArcUniswap.V4_POOL_MANAGER).initialize(erc20Key, ArcUniswap.PRICE_ONE);
        IArcV4PoolManager(ArcUniswap.V4_POOL_MANAGER).initialize(nativeKey, ArcUniswap.PRICE_ONE);

        vm.startPrank(alice);
        for (uint256 i; i < 2; ++i) {
            address t = i == 0 ? token0 : token1;
            MockToken(t).approve(address(V3), type(uint256).max);
            MockToken(t).approve(ArcUniswap.PERMIT2, type(uint256).max);
            IPermit2(ArcUniswap.PERMIT2).approve(t, address(V4), type(uint160).max, type(uint48).max);
        }
        vm.stopPrank();

        unlockAt = (block.timestamp + 30 days).toUint64();
        v3Id = _mintV3();
        v4Id = _mintV4(erc20Key);
        nativeId = _mintV4(nativeKey);
        v3Vault = _lock(address(V3), v3Id);
        v4Vault = _lock(address(V4), v4Id);
        nativeVault = _lock(address(V4), nativeId);
        handOverVault = _lock(address(V3), _mintV3());
        vm.prank(alice);
        handOverVault.transferOwnership(bob);
        freshV3Id = _mintV3();
        freshV4Id = _mintV4(erc20Key);
        freshNativeId = _mintV4(nativeKey);
        unlockedV4Id = _mintV4(erc20Key);
        vm.startPrank(alice);
        V3.approve(address(factory), freshV3Id);
        V4.approve(address(factory), freshV4Id);
        V4.approve(address(factory), freshNativeId);
        vm.stopPrank();

        // Trade both ways in every pool, so every position has earned fees in both currencies.
        for (uint256 i; i < 2; ++i) {
            swapper.swapV3(v3Pool, i == 0, SWAP);
            swapper.swapV4(erc20Key, i == 0, SWAP);
            swapper.swapV4(nativeKey, i == 0, SWAP);
        }
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _fund(address who) internal {
        vm.deal(who, 1_000_000 ether);
        MockToken(token0).mint(who, 1_000_000 ether);
        MockToken(token1).mint(who, 1_000_000 ether);
    }

    function _key(address currency0, address currency1) internal pure returns (IV4PositionManager.PoolKey memory) {
        return IV4PositionManager.PoolKey(currency0, currency1, ArcUniswap.FEE, ArcUniswap.TICK_SPACING, address(0));
    }

    function _mintV3() internal returns (uint256 id) {
        vm.prank(alice);
        (id,,,) = V3.mint(
            IArcV3PositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: ArcUniswap.FEE,
                tickLower: -ArcUniswap.MAX_TICK,
                tickUpper: ArcUniswap.MAX_TICK,
                amount0Desired: DEPOSIT,
                amount1Desired: DEPOSIT,
                amount0Min: 0,
                amount1Min: 0,
                recipient: alice,
                deadline: block.timestamp
            })
        );
    }

    /// Alice mints a full-range v4 position through the real PositionManager, paying through Permit2 (ERC-20) or
    /// with value, whose excess is swept back to her (native).
    function _mintV4(IV4PositionManager.PoolKey memory key) internal returns (uint256 id) {
        bool native = key.currency0 == address(0);
        id = V4.nextTokenId();
        bytes memory actions = native
            ? abi.encodePacked(ArcUniswap.MINT_POSITION, ArcUniswap.SETTLE_PAIR, ArcUniswap.SWEEP)
            : abi.encodePacked(ArcUniswap.MINT_POSITION, ArcUniswap.SETTLE_PAIR);
        bytes[] memory params = new bytes[](native ? 3 : 2);
        params[0] = abi.encode(
            key,
            -ArcUniswap.MAX_TICK,
            ArcUniswap.MAX_TICK,
            uint256(V4_LIQUIDITY),
            type(uint128).max,
            type(uint128).max,
            alice,
            bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1);
        if (native) params[2] = abi.encode(address(0), alice);
        vm.prank(alice);
        V4.modifyLiquidities{value: native ? 2 * DEPOSIT : 0}(abi.encode(actions, params), block.timestamp);
        assertEq(V4.ownerOf(id), alice);
    }

    function _lock(address manager, uint256 id) internal returns (PositionVault vault) {
        vm.startPrank(alice);
        if (manager == address(V3)) V3.approve(address(factory), id);
        else V4.approve(address(factory), id);
        vault = PositionVault(payable(factory.lockPosition{value: FLAT}(manager, id, unlockAt, alice)));
        vm.stopPrank();
    }

    function _v3Liquidity(uint256 id) internal view returns (uint128 liquidity) {
        (,,,,,,, liquidity,,,,) = V3.positions(id);
    }

    function _liquidity(PositionVault vault) internal view returns (uint128) {
        return vault.kind() == PositionVault.Kind.V3
            ? _v3Liquidity(vault.tokenId())
            : V4.getPositionLiquidity(vault.tokenId());
    }

    function _ownerOf(PositionVault vault) internal view returns (address) {
        return IV3PositionManager(vault.manager()).ownerOf(vault.tokenId()); // the same ERC-721 call on v4
    }

    function _balance(address currency, address who) internal view returns (uint256) {
        return currency == address(0) ? who.balance : MockToken(currency).balanceOf(who);
    }

    /// Nothing a flow does may touch USDC's ERC-20 at 0x3600, which a fork cannot run.
    function _assertUsdcUntouched(Vm.AccountAccess[] memory accesses) internal pure {
        for (uint256 i; i < accesses.length; ++i) {
            assertTrue(accesses[i].account != USDC && accesses[i].accessor != USDC, "touched 0x3600");
        }
    }

    /// The owner collects; the platform gets exactly its share of what arrived, the owner the rest, per currency; the
    /// liquidity and the NFT stay where they were; and a second collect finds nothing left.
    function _collectAndCheckTheSplit(PositionVault vault) internal {
        (address c0, address c1) = vault.currencies();
        uint128 liquidity = _liquidity(vault);
        uint256[2] memory owner0 = [_balance(c0, alice), _balance(c1, alice)];
        uint256[2] memory platform0 = [_balance(c0, feeRecipient), _balance(c1, feeRecipient)];

        vm.startStateDiffRecording();
        vm.prank(alice);
        vault.collect();
        _assertUsdcUntouched(vm.stopAndReturnStateDiff());

        for (uint256 i; i < 2; ++i) {
            address c = i == 0 ? c0 : c1;
            uint256 toOwner = _balance(c, alice) - owner0[i];
            uint256 toPlatform = _balance(c, feeRecipient) - platform0[i];
            uint256 total = toOwner + toPlatform;
            assertGt(total, 0, "no fees arrived");
            assertEq(toPlatform, total * SHARE_BPS / BPS, "the platform's share");
            assertEq(_balance(c, address(vault)), 0, "the vault kept some");
        }
        assertEq(_liquidity(vault), liquidity, "the liquidity moved");
        assertEq(_ownerOf(vault), address(vault), "the position left the vault");

        // A second collect finds nothing: the managers still log their zero-amount pokes, but the vault logs nothing
        // and no balance moves.
        owner0 = [_balance(c0, alice), _balance(c1, alice)];
        platform0 = [_balance(c0, feeRecipient), _balance(c1, feeRecipient)];
        vm.recordLogs();
        vm.prank(alice);
        vault.collect();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].emitter != address(vault), "a second collect found more");
        }
        assertEq(_balance(c0, alice), owner0[0]);
        assertEq(_balance(c1, alice), owner0[1]);
        assertEq(_balance(c0, feeRecipient), platform0[0]);
        assertEq(_balance(c1, feeRecipient), platform0[1]);
    }

    // ---------------------------------------------------------------------
    // Locking
    // ---------------------------------------------------------------------

    function test_lockPosition_pullsTheRealPositionIntoItsVault_andRegistersBothCurrencies() public view {
        PositionVault[3] memory vaults = [v3Vault, v4Vault, nativeVault];
        uint256[3] memory ids = [v3Id, v4Id, nativeId];
        for (uint256 i; i < 3; ++i) {
            assertEq(_ownerOf(vaults[i]), address(vaults[i]));
            assertEq(vaults[i].tokenId(), ids[i]);
            assertEq(vaults[i].owner(), alice);
            assertEq(vaults[i].unlockAt(), unlockAt);
            assertEq(vaults[i].feeShareBps(), SHARE_BPS);
            assertEq(vaults[i].feeRecipient(), feeRecipient);
            assertTrue(factory.isVault(address(vaults[i])));
        }
        (address c0, address c1) = v3Vault.currencies();
        assertEq(c0, token0);
        assertEq(c1, token1);
        (c0, c1) = nativeVault.currencies();
        assertEq(c0, address(0));
        assertEq(c1, token0);
        address[] memory forToken0 = factory.positionVaultsForToken(token0);
        assertEq(forToken0.length, 4); // and handOverVault
        assertEq(forToken0[0], address(v3Vault));
        assertEq(forToken0[1], address(v4Vault));
        assertEq(forToken0[2], address(nativeVault));
        assertEq(factory.positionVaultsForTokenLength(token1), 3);
        address[] memory forNative = factory.positionVaultsForToken(address(0));
        assertEq(forNative.length, 1);
        assertEq(forNative[0], address(nativeVault));
    }

    function test_lockPosition_withoutApprovalOfTheFactory_reverts() public {
        uint256 id = _mintV3();
        vm.prank(alice);
        vm.expectRevert(bytes(V3_NOT_APPROVED));
        factory.lockPosition{value: FLAT}(address(V3), id, unlockAt, alice);
        id = _mintV4(erc20Key);
        vm.prank(alice);
        vm.expectRevert(bytes("NOT_AUTHORIZED"));
        factory.lockPosition{value: FLAT}(address(V4), id, unlockAt, alice);
    }

    /// `liquidity()` reads the live liquidity from the real managers, and every lock made in setUp holds some.
    function test_liquidity_isTheRealManagersLiveLiquidity() public view {
        PositionVault[3] memory vaults = [v3Vault, v4Vault, nativeVault];
        for (uint256 i; i < 3; ++i) {
            assertGt(vaults[i].liquidity(), 0);
            assertEq(vaults[i].liquidity(), _liquidity(vaults[i]));
        }
        assertEq(v4Vault.liquidity(), V4_LIQUIDITY);
    }

    /// Review I1, on the real v4 manager: a position whose liquidity was all removed holds no principal, and a vault
    /// for it could never collect; the lock is refused.
    function test_lockPosition_refusesAV4PositionWithNoLiquidity() public {
        uint256 id = _mintV4(erc20Key);
        vm.startPrank(alice);
        V4.modifyLiquidities(_decreaseAndTake(id, V4_LIQUIDITY, erc20Key, alice), block.timestamp);
        assertEq(V4.getPositionLiquidity(id), 0);
        V4.approve(address(factory), id);
        vm.expectRevert(VaultFactory.NoLiquidity.selector);
        factory.lockPosition{value: FLAT}(address(V4), id, unlockAt, alice);
        vm.stopPrank();
        assertEq(V4.ownerOf(id), alice);
    }

    /// Review I1, on the real v3 manager: a decrease without a collect leaves the principal in `tokensOwed`, where
    /// the vault's first collect would release it as fees. Refused; once collected, the rest of the position locks.
    function test_lockPosition_refusesAV3PositionDecreasedButNotCollected_thenLocksItOnceCollected() public {
        uint256 id = _mintV3();
        uint128 liquidity = _v3Liquidity(id);
        vm.startPrank(alice);
        V3.decreaseLiquidity(IArcV3PositionManager.DecreaseLiquidityParams(id, liquidity / 2, 0, 0, block.timestamp));
        V3.approve(address(factory), id);
        vm.expectRevert(VaultFactory.OwedNotCollected.selector);
        factory.lockPosition{value: FLAT}(address(V3), id, unlockAt, alice);
        assertEq(V3.ownerOf(id), alice);

        V3.collect(IV3PositionManager.CollectParams(id, alice, type(uint128).max, type(uint128).max));
        PositionVault vault =
            PositionVault(payable(factory.lockPosition{value: FLAT}(address(V3), id, unlockAt, alice)));
        vm.stopPrank();
        assertEq(V3.ownerOf(id), address(vault));
        assertEq(vault.liquidity(), liquidity - liquidity / 2);
    }

    /// And a v3 position emptied and collected is refused as having no liquidity.
    function test_lockPosition_refusesAnEmptiedV3Position() public {
        uint256 id = _mintV3();
        uint128 liquidity = _v3Liquidity(id);
        vm.startPrank(alice);
        V3.decreaseLiquidity(IArcV3PositionManager.DecreaseLiquidityParams(id, liquidity, 0, 0, block.timestamp));
        V3.collect(IV3PositionManager.CollectParams(id, alice, type(uint128).max, type(uint128).max));
        V3.approve(address(factory), id);
        vm.expectRevert(VaultFactory.NoLiquidity.selector);
        factory.lockPosition{value: FLAT}(address(V3), id, unlockAt, alice);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------
    // Collecting: the split, and the v4 action bytes
    // ---------------------------------------------------------------------

    function test_v3_collect_splitsTheFees_andLeavesThePrincipal() public {
        _collectAndCheckTheSplit(v3Vault);
        (,,,,,,,,,, uint128 owed0, uint128 owed1) = V3.positions(v3Id);
        assertEq(owed0, 0);
        assertEq(owed1, 0);
    }

    function test_v4_collect_splitsTheFees_andLeavesThePrincipal() public {
        _collectAndCheckTheSplit(v4Vault);
    }

    function test_v4Native_collect_splitsTheFees_andLeavesThePrincipal() public {
        _collectAndCheckTheSplit(nativeVault);
    }

    /// The v4 action bytes on the deployed PositionManager: action 0x01 decreases a position's liquidity by the amount given, and 0x11
    /// pays both currencies to the recipient, with the parameter encoding the vault uses.
    function test_v4ActionBytes_decreaseAndTakePair_onTheDeployedPositionManager() public {
        bytes memory actions = abi.encodePacked(uint8(0x01), uint8(0x11));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(unlockedV4Id, uint256(V4_LIQUIDITY / 4), uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(token0, token1, alice);
        uint256 before0 = _balance(token0, alice);
        uint256 before1 = _balance(token1, alice);
        vm.prank(alice);
        V4.modifyLiquidities(abi.encode(actions, params), block.timestamp);
        assertEq(V4.getPositionLiquidity(unlockedV4Id), V4_LIQUIDITY - V4_LIQUIDITY / 4, "0x01 is not a decrease");
        assertGt(_balance(token0, alice), before0, "0x11 did not pay currency0");
        assertGt(_balance(token1, alice), before1, "0x11 did not pay currency1");
    }

    function test_collect_keepsWorkingAfterMoreTrading() public {
        _collectAndCheckTheSplit(v4Vault);
        swapper.swapV4(erc20Key, true, SWAP); // fees are paid in the input currency, so trade both ways
        swapper.swapV4(erc20Key, false, SWAP);
        _collectAndCheckTheSplit(v4Vault);
    }

    // ---------------------------------------------------------------------
    // Every early exit fails
    // ---------------------------------------------------------------------

    function test_v3_everyEarlyExitFails_thenTheOwnerWithdrawsAWorkingPosition() public {
        uint128 liquidity = _v3Liquidity(v3Id);
        _assertTheVaultRefusesEarlyExits(v3Vault);

        vm.startPrank(alice);
        vm.expectRevert(bytes("Not approved"));
        V3.decreaseLiquidity(IArcV3PositionManager.DecreaseLiquidityParams(v3Id, liquidity, 0, 0, block.timestamp));
        vm.expectRevert(bytes("Not approved"));
        V3.collect(IV3PositionManager.CollectParams(v3Id, alice, type(uint128).max, type(uint128).max));
        vm.expectRevert(bytes("Not approved"));
        V3.burn(v3Id);
        vm.expectRevert(bytes(V3_NOT_APPROVED));
        V3.transferFrom(address(v3Vault), alice, v3Id);
        vm.expectRevert(bytes(V3_NOT_APPROVED));
        V3.safeTransferFrom(address(v3Vault), alice, v3Id);
        vm.expectRevert(bytes("ERC721: approve caller is not owner nor approved for all"));
        V3.approve(alice, v3Id);
        V3.setApprovalForAll(bob, true); // an operator for alice's own NFTs, not the vault's
        vm.stopPrank();
        vm.prank(bob);
        vm.expectRevert(bytes(V3_NOT_APPROVED));
        V3.transferFrom(address(v3Vault), bob, v3Id);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceWallet, keccak256("any digest"));
        // The vault is the owner, and it signs nothing: the manager's ERC-1271 call hits no function and no fallback,
        // and reverts without data.
        vm.expectRevert(bytes(""));
        V3.permit(alice, v3Id, block.timestamp, v, r, s);

        assertEq(V3.ownerOf(v3Id), address(v3Vault));
        assertEq(V3.getApproved(v3Id), address(0));
        assertEq(_v3Liquidity(v3Id), liquidity);

        _withdrawAtUnlock(v3Vault);
        vm.startPrank(alice);
        V3.decreaseLiquidity(IArcV3PositionManager.DecreaseLiquidityParams(v3Id, liquidity, 0, 0, block.timestamp));
        assertEq(_v3Liquidity(v3Id), 0);
        // The positive control for the refused burn: the same call works for the owner of an emptied position.
        V3.collect(IV3PositionManager.CollectParams(v3Id, alice, type(uint128).max, type(uint128).max));
        V3.burn(v3Id);
        vm.stopPrank();
        vm.expectRevert(bytes("ERC721: owner query for nonexistent token"));
        V3.ownerOf(v3Id);
    }

    function test_v4_everyEarlyExitFails_thenTheOwnerWithdrawsAWorkingPosition() public {
        _v4EarlyExitsThenWithdraw(v4Vault, erc20Key);
    }

    function test_v4Native_everyEarlyExitFails_thenTheOwnerWithdrawsAWorkingPosition() public {
        _v4EarlyExitsThenWithdraw(nativeVault, nativeKey);
    }

    function _v4EarlyExitsThenWithdraw(PositionVault vault, IV4PositionManager.PoolKey memory key) internal {
        uint256 id = vault.tokenId();
        uint128 liquidity = V4.getPositionLiquidity(id);
        _assertTheVaultRefusesEarlyExits(vault);

        bytes memory notApproved = abi.encodeWithSelector(IArcV4PositionManager.NotApproved.selector, alice);
        vm.startPrank(alice);
        vm.expectRevert(notApproved); // decrease the principal, to herself
        V4.modifyLiquidities(_decreaseAndTake(id, liquidity, key, alice), block.timestamp);
        vm.expectRevert(notApproved); // collect the fees around the vault, to herself
        V4.modifyLiquidities(_decreaseAndTake(id, 0, key, alice), block.timestamp);
        vm.expectRevert(notApproved); // burn
        V4.modifyLiquidities(_burn(id, key, alice), block.timestamp);
        vm.expectRevert(bytes("NOT_AUTHORIZED"));
        V4.transferFrom(address(vault), alice, id);
        vm.expectRevert(bytes("NOT_AUTHORIZED"));
        V4.safeTransferFrom(address(vault), alice, id);
        vm.expectRevert(IArcV4PositionManager.Unauthorized.selector);
        V4.approve(alice, id);
        V4.setApprovalForAll(bob, true); // an operator for alice's own NFTs, not the vault's
        vm.stopPrank();
        vm.prank(bob);
        vm.expectRevert(bytes("NOT_AUTHORIZED"));
        V4.transferFrom(address(vault), bob, id);
        bytes memory signature;
        {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceWallet, keccak256("any digest"));
            signature = abi.encodePacked(r, s, v);
        }
        // The vault is the owner, and it signs nothing: the manager's ERC-1271 call hits no function and no fallback,
        // and reverts without data.
        vm.expectRevert(bytes(""));
        V4.permit(alice, id, block.timestamp, 0, signature);

        assertEq(V4.ownerOf(id), address(vault));
        assertEq(V4.getApproved(id), address(0));
        assertEq(V4.getPositionLiquidity(id), liquidity);

        _withdrawAtUnlock(vault);
        vm.startPrank(alice);
        V4.modifyLiquidities(_decreaseAndTake(id, liquidity, key, alice), block.timestamp);
        assertEq(V4.getPositionLiquidity(id), 0);
        // The positive control for the refused burn: the same payload works for the position's owner, so the refusal
        // above was the manager's NotApproved, not a malformed action.
        V4.modifyLiquidities(_burn(id, key, alice), block.timestamp);
        vm.stopPrank();
        vm.expectRevert(bytes("NOT_MINTED"));
        V4.ownerOf(id);
    }

    /// The vault's own guards, for the owner and for anyone else; then the lock still holds.
    function _assertTheVaultRefusesEarlyExits(PositionVault vault) internal {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PositionVault.StillLocked.selector, unlockAt));
        vault.withdraw(alice);
        vm.warp(unlockAt - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PositionVault.StillLocked.selector, unlockAt));
        vault.withdraw(alice);
        vm.startPrank(stranger);
        vm.expectRevert(PositionVault.NotOwner.selector);
        vault.withdraw(stranger);
        vm.expectRevert(PositionVault.NotOwner.selector);
        vault.collect();
        vm.expectRevert(PositionVault.NotOwner.selector);
        vault.extend(unlockAt + 1);
        vm.expectRevert(PositionVault.NotOwner.selector);
        vault.transferOwnership(stranger);
        vm.stopPrank();
        assertEq(_ownerOf(vault), address(vault));
    }

    function _withdrawAtUnlock(PositionVault vault) internal {
        vm.warp(unlockAt);
        vm.prank(stranger);
        vm.expectRevert(PositionVault.NotOwner.selector);
        vault.withdraw(stranger);
        vm.prank(alice);
        vault.withdraw(alice);
        assertEq(_ownerOf(vault), alice);
    }

    function _decreaseAndTake(uint256 id, uint256 liquidity, IV4PositionManager.PoolKey memory key, address to)
        internal
        pure
        returns (bytes memory)
    {
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(id, liquidity, uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1, to);
        return abi.encode(abi.encodePacked(ArcUniswap.DECREASE_LIQUIDITY, ArcUniswap.TAKE_PAIR), params);
    }

    function _burn(uint256 id, IV4PositionManager.PoolKey memory key, address to) internal pure returns (bytes memory) {
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(id, uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1, to);
        return abi.encode(abi.encodePacked(ArcUniswap.BURN_POSITION, ArcUniswap.TAKE_PAIR), params);
    }

    // ---------------------------------------------------------------------
    // Gas on the real managers (logged with -vv)
    // ---------------------------------------------------------------------
    //
    // Measured as VaultGas.t.sol does: setUp and each test are separate transactions, so the measured call meets cold
    // storage; the frame's gas from `lastCallGas`, plus the 21,000 intrinsic gas and the calldata. Run without
    // `--isolate`. Fees are in two mock ERC-20s or native value, so a USDC leg would cost differently.

    function _calldataGas(bytes memory data) internal pure returns (uint256 gas) {
        for (uint256 i; i < data.length; ++i) {
            gas += data[i] == 0 ? 4 : 16;
        }
    }

    function _measure(address caller, string memory name, address target, uint256 value, bytes memory data)
        internal
        returns (uint256 txGas)
    {
        assertGt(target.code.length, 0); // warms the target, as a transaction's target is warm
        vm.prank(caller);
        (bool ok,) = target.call{value: value}(data);
        assertTrue(ok, "the measured call reverted");
        txGas = vm.lastCallGas().gasTotalUsed + INTRINSIC + _calldataGas(data);
        emit log_named_uint(string.concat(name, ": transaction gas"), txGas);
    }

    function _lockData(address manager, uint256 id) internal view returns (bytes memory) {
        return abi.encodeCall(VaultFactory.lockPosition, (manager, id, unlockAt, alice));
    }

    function test_gas_lockPosition_v3() public {
        _measure(alice, "lockPosition, Uniswap v3", address(factory), FLAT, _lockData(address(V3), freshV3Id));
    }

    function test_gas_lockPosition_v4() public {
        _measure(
            alice, "lockPosition, Uniswap v4, two ERC-20s", address(factory), FLAT, _lockData(address(V4), freshV4Id)
        );
    }

    function test_gas_lockPosition_v4Native() public {
        _measure(
            alice, "lockPosition, Uniswap v4, native", address(factory), FLAT, _lockData(address(V4), freshNativeId)
        );
    }

    function test_gas_collect_v3() public {
        _measure(alice, "collect, Uniswap v3", address(v3Vault), 0, abi.encodeCall(PositionVault.collect, ()));
    }

    function test_gas_collect_v4() public {
        _measure(
            alice, "collect, Uniswap v4, two ERC-20s", address(v4Vault), 0, abi.encodeCall(PositionVault.collect, ())
        );
    }

    function test_gas_collect_v4Native() public {
        _measure(
            alice, "collect, Uniswap v4, native", address(nativeVault), 0, abi.encodeCall(PositionVault.collect, ())
        );
    }

    function test_gas_extend() public {
        _measure(
            alice, "PositionVault.extend", address(v3Vault), 0, abi.encodeCall(PositionVault.extend, (unlockAt + 1))
        );
    }

    function test_gas_transferOwnership() public {
        _measure(
            alice,
            "PositionVault.transferOwnership",
            address(v3Vault),
            0,
            abi.encodeCall(PositionVault.transferOwnership, (bob))
        );
    }

    function test_gas_acceptOwnership() public {
        _measure(
            bob,
            "PositionVault.acceptOwnership",
            address(handOverVault),
            0,
            abi.encodeCall(PositionVault.acceptOwnership, ())
        );
    }

    function test_gas_withdraw_v3() public {
        vm.warp(unlockAt);
        _measure(alice, "withdraw, Uniswap v3", address(v3Vault), 0, abi.encodeCall(PositionVault.withdraw, (alice)));
    }

    function test_gas_withdraw_v4() public {
        vm.warp(unlockAt);
        _measure(alice, "withdraw, Uniswap v4", address(v4Vault), 0, abi.encodeCall(PositionVault.withdraw, (alice)));
    }
}
