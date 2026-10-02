// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {FeeController} from "../../src/FeeController.sol";
import {LockVault} from "../../src/vault/LockVault.sol";
import {VaultFactory} from "../../src/vault/VaultFactory.sol";
import {VaultTestBase} from "./VaultTestBase.sol";
import {
    MockFalseReturnToken,
    MockFeeOnTransferToken,
    MockNoBalanceToken,
    MockNoReturnToken,
    MockRebasingToken,
    MockShapedToken,
    MockV2Pair,
    MockZeroTransferToken
} from "./mocks/VaultMocks.sol";

/// How a vault behaves with tokens that are not plain ERC-20s. The decision, pinned here: the vault records no
/// amount and `withdraw` sends its live balance, and the factory records what actually ARRIVED (the vault's balance
/// before and after the transfer), never what was asked for. A token that delivers nothing is refused. Nothing is
/// refused merely because it delivered a little less than asked, since shares-based rebasing tokens do that at random.
contract VaultTokensTest is VaultTestBase {
    using SafeCast for uint256;

    bytes4 internal constant SEL_TOKEN0 = bytes4(keccak256("token0()"));
    bytes4 internal constant SEL_TOKEN1 = bytes4(keccak256("token1()"));
    bytes4 internal constant SEL_RESERVES = bytes4(keccak256("getReserves()"));

    function _fund(IERC20 t, address user, uint256 amount, function(address, uint256) external mintFn) internal {
        mintFn(user, amount);
        vm.prank(user);
        t.approve(address(factory), type(uint256).max);
    }

    // ---------------------------------------------------------------------
    // Fee-on-transfer
    // ---------------------------------------------------------------------

    function test_feeOnTransfer_recordsTheReceivedAmount() public {
        MockFeeOnTransferToken taxed = new MockFeeOnTransferToken(1_000); // 10% burned on every transfer
        _fund(IERC20(address(taxed)), alice, 10_000 ether, taxed.mint);
        Snap memory s = _snap(alice, address(taxed));
        uint64 at = (block.timestamp + 30 days).toUint64();

        vm.expectEmit(true, true, false, true, address(factory));
        emit VaultFactory.TokenLocked(alice, address(taxed), s.predicted, 900 ether, 0, at); // 900 arrived, not 1,000
        vm.prank(alice);
        address vault = factory.lockToken{value: FLAT}(IERC20(address(taxed)), 1_000 ether, at, alice);

        assertEq(taxed.balanceOf(vault), 900 ether);
        assertEq(LockVault(vault).lockedAmount(), 900 ether);
        assertEq(taxed.balanceOf(address(factory)), 0);
    }

    function test_feeOnTransfer_vaultReleasesWhatItHolds_tokenTaxesTheExitToo() public {
        MockFeeOnTransferToken taxed = new MockFeeOnTransferToken(1_000);
        _fund(IERC20(address(taxed)), alice, 10_000 ether, taxed.mint);
        LockVault v = _lock(alice, IERC20(address(taxed)), 1_000 ether, 30 days, alice);
        vm.warp(v.unlockAt());

        uint256 bobBefore = taxed.balanceOf(bob);
        vm.prank(alice);
        v.withdraw(bob);

        assertEq(taxed.balanceOf(address(v)), 0); // the vault sent everything it held ...
        assertEq(taxed.balanceOf(bob) - bobBefore, 810 ether); // ... and the token took its 10% again on the way out
    }

    function test_feeOnTransfer_lpPair_feeReportedAsSent_lockedAsReceived() public {
        MockV2Pair taxedPair = new MockV2Pair(address(token), address(0xdead), 1_000); // a pair-shaped, 10% taxed token
        _fund(IERC20(address(taxedPair)), alice, 10_000 ether, taxedPair.mint);
        Snap memory s = _snap(alice, address(taxedPair));
        uint64 at = (block.timestamp + 30 days).toUint64();

        // 50 LP tokens are sent as the fee and 9,950 to the vault. The token burns 10% of each on the way.
        vm.expectEmit(true, true, false, true, address(factory));
        emit VaultFactory.TokenLocked(alice, address(taxedPair), s.predicted, 8_955 ether, 50 ether, at);
        vm.prank(alice);
        address vault = factory.lockToken{value: FLAT}(IERC20(address(taxedPair)), 10_000 ether, at, alice);

        assertEq(taxedPair.balanceOf(feeRecipient), 45 ether); // what the recipient received
        assertEq(taxedPair.balanceOf(vault), 8_955 ether);
    }

    // ---------------------------------------------------------------------
    // Rebasing
    // ---------------------------------------------------------------------

    function test_rebasing_liveBalanceGoesUp() public {
        MockRebasingToken rt = new MockRebasingToken();
        _fund(IERC20(address(rt)), alice, 1_000 ether, rt.mint);
        LockVault v = _lock(alice, IERC20(address(rt)), 1_000 ether, 30 days, alice);
        assertEq(v.lockedAmount(), 1_000 ether);

        rt.rebase(1.5e18); // every balance grows by half
        assertEq(v.lockedAmount(), 1_500 ether);

        vm.warp(v.unlockAt());
        vm.prank(alice);
        v.withdraw(bob);
        assertEq(rt.balanceOf(bob), 1_500 ether); // the owner gets the balance the vault holds at that moment
        assertEq(rt.balanceOf(address(v)), 0);
    }

    function test_rebasing_liveBalanceGoesDown() public {
        MockRebasingToken rt = new MockRebasingToken();
        _fund(IERC20(address(rt)), alice, 1_000 ether, rt.mint);
        LockVault v = _lock(alice, IERC20(address(rt)), 1_000 ether, 30 days, alice);

        rt.rebase(0.5e18); // every balance halves
        assertEq(v.lockedAmount(), 500 ether);

        vm.warp(v.unlockAt());
        vm.prank(alice);
        v.withdraw(bob);
        assertEq(rt.balanceOf(bob), 500 ether);
        assertEq(rt.balanceOf(address(v)), 0);
    }

    function test_rebasing_recordsTheReceivedAmount_whenTheTokenRoundsDown() public {
        MockRebasingToken rt = new MockRebasingToken();
        rt.rebase(2e18); // one share is worth 2 wei
        _fund(IERC20(address(rt)), alice, 2_000, rt.mint);
        Snap memory s = _snap(alice, address(rt));
        uint64 at = (block.timestamp + 30 days).toUint64();

        // Asking for an odd 1,001 moves 500 whole shares, which is 1,000 wei. A check for "received == asked" would
        // have refused this lock; recording what arrived keeps it and says 1,000.
        vm.expectEmit(true, true, false, true, address(factory));
        emit VaultFactory.TokenLocked(alice, address(rt), s.predicted, 1_000, 0, at);
        vm.prank(alice);
        address vault = factory.lockToken{value: FLAT}(IERC20(address(rt)), 1_001, at, alice);

        assertEq(rt.balanceOf(vault), 1_000);
        assertEq(LockVault(vault).lockedAmount(), 1_000);
    }

    // ---------------------------------------------------------------------
    // Nothing arrived
    // ---------------------------------------------------------------------

    function test_zeroReceived_reverts() public {
        MockZeroTransferToken broken = new MockZeroTransferToken();
        Snap memory s = _snap(alice, address(broken));
        uint64 at = (block.timestamp + 30 days).toUint64();

        vm.prank(alice);
        vm.expectRevert(VaultFactory.ZeroAmount.selector);
        factory.lockToken{value: FLAT}(IERC20(address(broken)), 1 ether, at, alice);

        _assertNothingLeftBehind(s, alice, address(broken));
    }

    function test_zeroReceived_whenTheLpFeeTakesEverything() public {
        FeeController c = _newFeeController(FLAT, FLAT_CAP, 10_000, 10_000, SHARE_BPS, SHARE_BPS_CAP);
        VaultFactory f = new VaultFactory(factoryOwner, c);
        vm.prank(alice);
        pair.approve(address(f), type(uint256).max);
        uint256 aliceLp = pair.balanceOf(alice);
        uint64 at = (block.timestamp + 30 days).toUint64();

        vm.prank(alice);
        vm.expectRevert(VaultFactory.ZeroAmount.selector); // 100% fee leaves nothing to lock
        f.lockToken{value: FLAT}(IERC20(address(pair)), 10_000 ether, at, alice);

        assertEq(pair.balanceOf(alice), aliceLp);
        assertEq(f.vaultsOfLength(alice), 0);
    }

    function test_tokenThatCannotReportBalances_reverts() public {
        MockNoBalanceToken blind = new MockNoBalanceToken();
        Snap memory s = _snap(alice, address(blind));
        uint64 at = (block.timestamp + 30 days).toUint64();

        vm.prank(alice);
        vm.expectRevert(); // no answer to balanceOf: fail closed
        factory.lockToken{value: FLAT}(IERC20(address(blind)), 1 ether, at, alice);

        _assertNothingLeftBehind(s, alice, address(blind));
    }

    // ---------------------------------------------------------------------
    // Return-value conventions
    // ---------------------------------------------------------------------

    function test_noReturnToken_works() public {
        MockNoReturnToken usdtLike = new MockNoReturnToken();
        usdtLike.mint(alice, 1_000 ether);
        vm.prank(alice);
        usdtLike.approve(address(factory), type(uint256).max);

        LockVault v = _lock(alice, IERC20(address(usdtLike)), 100 ether, 30 days, alice);
        assertEq(v.lockedAmount(), 100 ether);

        vm.warp(v.unlockAt());
        vm.prank(alice);
        v.withdraw(bob);
        assertEq(usdtLike.balanceOf(bob), 100 ether);
        assertEq(usdtLike.balanceOf(address(v)), 0);
    }

    function test_falseReturnToken_reverts() public {
        MockFalseReturnToken liar = new MockFalseReturnToken();
        Snap memory s = _snap(alice, address(liar));
        uint64 at = (block.timestamp + 30 days).toUint64();

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(liar)));
        factory.lockToken{value: FLAT}(IERC20(address(liar)), 1 ether, at, alice);

        _assertNothingLeftBehind(s, alice, address(liar));
    }

    // ---------------------------------------------------------------------
    // Tokens sent to the vault's address before it exists
    // ---------------------------------------------------------------------

    /// A vault's address is a function of the factory's nonce, so anyone can send tokens to it in advance. They are a
    /// gift to whoever owns the lock: not counted in the recorded amount, but held, and withdrawn with the rest.
    function test_preFundedPredictedAddress_isADonation_notPartOfTheRecordedAmount() public {
        Snap memory s = _snap(alice, address(token));
        token.mint(s.predicted, 7 ether);
        uint64 at = (block.timestamp + 30 days).toUint64();

        vm.expectEmit(true, true, false, true, address(factory));
        emit VaultFactory.TokenLocked(alice, address(token), s.predicted, 100 ether, 0, at);
        vm.prank(alice);
        address vault = factory.lockToken{value: FLAT}(token, 100 ether, at, alice);

        assertEq(vault, s.predicted);
        assertEq(LockVault(vault).lockedAmount(), 107 ether);
        vm.warp(at);
        uint256 bobBefore = token.balanceOf(bob);
        vm.prank(alice);
        LockVault(vault).withdraw(bob);
        assertEq(token.balanceOf(bob) - bobBefore, 107 ether);
    }

    // ---------------------------------------------------------------------
    // What counts as a v2 pair: the full shape, exactly
    // ---------------------------------------------------------------------

    struct Shape {
        string name;
        uint256 words0; // token0(): words returned
        bool reverts0;
        uint256 words1; // token1()
        bool reverts1;
        uint256 wordsR; // getReserves()
        bool revertsR;
        bool pays; // does the LP fee apply?
    }

    function _shapes() internal pure returns (Shape[] memory s) {
        s = new Shape[](9);
        s[0] = Shape("the full v2 shape: 32, 32 and 96 bytes", 1, false, 1, false, 3, false, true);
        s[1] = Shape("no token1", 1, false, 0, true, 3, false, false);
        s[2] = Shape("no getReserves (a v3 pool has token0 and token1 only)", 1, false, 1, false, 0, true, false);
        s[3] = Shape("reserves of 64 bytes", 1, false, 1, false, 2, false, false);
        s[4] = Shape("reserves of 128 bytes", 1, false, 1, false, 4, false, false);
        s[5] = Shape("token0 of 64 bytes", 2, false, 1, false, 3, false, false);
        s[6] = Shape("token1 answers with nothing", 1, false, 0, false, 3, false, false);
        s[7] = Shape("token0 answers with nothing", 0, false, 1, false, 3, false, false);
        s[8] = Shape("none of the three exists (a plain token)", 0, true, 0, true, 0, true, false);
    }

    function test_pairShape_onlyTheFullV2ShapePaysTheLpFee() public {
        Shape[] memory shapes = _shapes();
        for (uint256 i; i < shapes.length; ++i) {
            Shape memory sh = shapes[i];
            MockShapedToken t = new MockShapedToken();
            t.shape(SEL_TOKEN0, sh.words0, sh.reverts0);
            t.shape(SEL_TOKEN1, sh.words1, sh.reverts1);
            t.shape(SEL_RESERVES, sh.wordsR, sh.revertsR);
            _fund(IERC20(address(t)), alice, 10_000 ether, t.mint);

            LockVault v = _lock(alice, IERC20(address(t)), 10_000 ether, 30 days, alice);

            uint256 fee = t.balanceOf(feeRecipient);
            assertEq(fee, sh.pays ? 50 ether : 0, sh.name);
            assertEq(t.balanceOf(address(v)), 10_000 ether - fee, sh.name);
        }
    }
}
