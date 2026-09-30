// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {FeeController} from "../../src/FeeController.sol";
import {ArcVesting} from "../../src/vesting/ArcVesting.sol";
import {VestingFactory} from "../../src/vesting/VestingFactory.sol";
import {MockFeeOnTransferToken, MockToken} from "../vault/mocks/VaultMocks.sol";

/// Drives random sequences of creations (valid and invalid), releases by anyone, native releases, donations,
/// ownership transfers, fee changes and time passing, and keeps an exact ledger of every wallet: what it was funded
/// with, what it has released, and what its schedule says must have vested.
///
/// `fail_on_revert` is on (foundry.toml), so the handler catches every call into the contracts under test; a revert
/// that reaches the fuzzer is a bug in the handler itself. Every action predicts its own outcome and sets a flag
/// that never clears when the real outcome differs.
contract VestingHandler is Test {
    uint64 internal constant MAX_DURATION = 3650 days;
    bytes32 internal constant KEY_VEST = keccak256("VEST_FLAT");

    FeeController public immutable fees;
    VestingFactory public immutable factory;
    address public immutable feeOwner;
    address payable public immutable feeRecipient;
    IERC20 public immutable plain; // token 0: a plain ERC-20
    IERC20 public immutable taxed; // token 1: takes 1% of every transfer
    address[] internal actors;

    struct WalletInfo {
        ArcVesting wallet;
        uint8 tokenIdx;
        address beneficiary; // at creation
        uint64 start;
        uint64 duration;
        uint64 cliff;
        uint256 funded; // everything that ever arrived: the creation's delta plus donations
        uint256 released; // what the ledger says has left through release
        uint256 lastVested;
    }

    WalletInfo[] internal infos;

    uint256 public feesPaid; // native fees forwarded, per the ledger
    uint256 public plainPaidToOwners; // plain tokens owners received through releases
    uint256 public nonZeroReleases; // releases that moved tokens
    uint256[2] public createdForToken;
    mapping(address beneficiary => uint256) public createdFor;
    mapping(bytes4 selector => uint256) public succeeded;

    bool public unexpectedOutcome;
    bool public vestedDecreased;
    string public reason;

    constructor(
        FeeController fees_,
        VestingFactory factory_,
        address feeOwner_,
        address payable feeRecipient_,
        MockToken plain_,
        MockFeeOnTransferToken taxed_
    ) {
        fees = fees_;
        factory = factory_;
        feeOwner = feeOwner_;
        feeRecipient = feeRecipient_;
        plain = IERC20(address(plain_));
        taxed = IERC20(address(taxed_));
        for (uint256 i; i < 4; ++i) {
            address actor = makeAddr(string.concat("vestingActor", vm.toString(i)));
            actors.push(actor);
            vm.deal(actor, 1e24);
            plain_.mint(actor, 1e30);
            taxed_.mint(actor, 1e30);
            vm.startPrank(actor);
            plain_.approve(address(factory_), type(uint256).max);
            taxed_.approve(address(factory_), type(uint256).max);
            vm.stopPrank();
        }
    }

    // ---------------------------------------------------------------------
    // Views for the invariants
    // ---------------------------------------------------------------------

    function walletCount() external view returns (uint256) {
        return infos.length;
    }

    function info(uint256 i) external view returns (WalletInfo memory) {
        return infos[i];
    }

    function tokenAt(uint8 i) public view returns (IERC20) {
        return i == 0 ? plain : taxed;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function actorAt(uint256 i) external view returns (address) {
        return actors[i];
    }

    /// The schedule, from its definition, rounded down.
    function referenceVested(uint256 i, uint256 t) public view returns (uint256) {
        WalletInfo storage w = infos[i];
        if (t < uint256(w.start) + w.cliff) return 0;
        if (t >= uint256(w.start) + w.duration) return w.funded;
        return Math.mulDiv(w.funded, t - w.start, w.duration);
    }

    // ---------------------------------------------------------------------
    // Actions
    // ---------------------------------------------------------------------

    /// What one `create` call will do, worked out before the call so the outcome can be checked against it.
    struct CreatePlan {
        address creator;
        address beneficiary;
        uint8 tokenIdx;
        uint256 amount;
        uint64 start;
        uint64 duration;
        uint64 cliff;
        uint256 fee;
    }

    function create(
        uint256 actorSeed,
        uint256 beneficiarySeed,
        uint256 tokenSeed,
        uint256 amountSeed,
        uint256 startSeed,
        uint256 durationSeed,
        uint256 cliffSeed
    ) external {
        CreatePlan memory p;
        p.creator = _actor(actorSeed);
        p.beneficiary = _actor(beneficiarySeed);
        p.tokenIdx = tokenSeed % 2 == 0 ? 0 : 1;
        p.amount = bound(amountSeed, 1, 1e27);
        // Half the schedules are short, so that many cross their cliff and end inside one run.
        p.duration = durationSeed % 2 == 0
            ? uint64(bound(durationSeed / 2, 1, 120 days))
            : uint64(bound(durationSeed / 2, 1, MAX_DURATION));
        p.cliff = uint64(bound(cliffSeed, 0, p.duration));
        p.start = uint64(bound(startSeed, block.timestamp - 60 days, block.timestamp + 60 days));
        p.fee = fees.feeOf(KEY_VEST);
        _create(p);
        _sweep();
    }

    function _create(CreatePlan memory p) internal {
        IERC20 token = tokenAt(p.tokenIdx);
        uint256 recipientBefore = feeRecipient.balance;
        uint256 creatorBefore = token.balanceOf(p.creator);
        vm.prank(p.creator);
        try factory.createVesting{value: p.fee}(token, p.beneficiary, p.amount, p.start, p.duration, p.cliff) returns (
            address made
        ) {
            ArcVesting w = ArcVesting(payable(made));
            uint256 got = token.balanceOf(made);
            if (got != (p.tokenIdx == 0 ? p.amount : p.amount - p.amount / 100)) {
                _flag("a new wallet does not hold what arrived");
            }
            if (creatorBefore - token.balanceOf(p.creator) != p.amount) _flag("the creator paid a different amount");
            if (feeRecipient.balance - recipientBefore != p.fee) _flag("the fee was not forwarded");
            if (w.owner() != p.beneficiary || w.start() != p.start || w.duration() != p.duration) {
                _flag("a new wallet has the wrong owner or schedule");
            }
            if (w.cliff() != uint256(p.start) + p.cliff) _flag("a new wallet has the wrong cliff");
            if (!factory.isVesting(made)) _flag("a new wallet is not registered");
            feesPaid += p.fee;
            createdFor[p.beneficiary] += 1;
            createdForToken[p.tokenIdx] += 1;
            infos.push(WalletInfo(w, p.tokenIdx, p.beneficiary, p.start, p.duration, p.cliff, got, 0, 0));
            ++succeeded[this.create.selector];
        } catch {
            _flag("createVesting reverted for valid arguments");
        }
    }

    /// Each of the ways a creation must fail, chosen at random: nothing may change.
    function createInvalid(uint256 actorSeed, uint256 kind, uint256 seed) external {
        address creator = _actor(actorSeed);
        uint256 fee = fees.feeOf(KEY_VEST);
        uint256 value = fee;
        address beneficiary = _actor(seed);
        uint256 amount = 1 ether;
        uint64 start = uint64(block.timestamp);
        uint64 duration = 30 days;
        uint64 cliff = 0;
        kind = kind % 7;
        if (kind == 0) value = fee + 1 + (seed % 1 ether);
        else if (kind == 1) amount = 0;
        else if (kind == 2) duration = 0;
        else if (kind == 3) duration = uint64(bound(seed, uint256(MAX_DURATION) + 1, type(uint64).max));
        else if (kind == 4) cliff = uint64(bound(seed, uint256(duration) + 1, type(uint64).max));
        else if (kind == 5) start = uint64(bound(seed, block.timestamp + MAX_DURATION + 1, type(uint64).max));
        else beneficiary = address(0);
        if (kind == 0 && fee > 0 && seed % 2 == 0) value = fee - 1;
        uint256 nonce = vm.getNonce(address(factory));
        uint256 recipientBefore = feeRecipient.balance;
        uint256 creatorBefore = plain.balanceOf(creator);
        vm.prank(creator);
        try factory.createVesting{value: value}(plain, beneficiary, amount, start, duration, cliff) {
            _flag("an invalid creation succeeded");
        } catch {
            if (vm.getNonce(address(factory)) != nonce) _flag("a failed creation deployed something");
            if (feeRecipient.balance != recipientBefore) _flag("a failed creation paid a fee");
            if (plain.balanceOf(creator) != creatorBefore) _flag("a failed creation moved tokens");
            ++succeeded[this.createInvalid.selector];
        }
        _sweep();
    }

    function release(uint256 walletSeed, uint256 callerSeed) external {
        if (infos.length == 0) return;
        uint256 i = walletSeed % infos.length;
        WalletInfo storage w = infos[i];
        IERC20 token = tokenAt(w.tokenIdx);
        address owner_ = w.wallet.owner();
        address caller = callerSeed % 5 == 4 ? makeAddr("vestingStranger") : _actor(callerSeed);
        uint256 expected = referenceVested(i, block.timestamp) - w.released;
        uint256 ownerBefore = token.balanceOf(owner_);
        uint256 walletBefore = token.balanceOf(address(w.wallet));
        vm.prank(caller);
        try w.wallet.release(address(token)) {
            uint256 ownerGot = token.balanceOf(owner_) - ownerBefore;
            uint256 wantOwner = w.tokenIdx == 0 ? expected : expected - expected / 100;
            if (walletBefore - token.balanceOf(address(w.wallet)) != expected) _flag("release moved the wrong amount");
            if (ownerGot != wantOwner) _flag("the owner did not receive the release");
            if (w.tokenIdx == 0) plainPaidToOwners += ownerGot;
            w.released += expected;
            if (expected != 0) ++nonZeroReleases;
            if (w.wallet.released(address(token)) != w.released) _flag("released() disagrees with the ledger");
            if (block.timestamp < uint256(w.start) + w.cliff && expected != 0) _flag("released before the cliff");
            ++succeeded[this.release.selector];
        } catch {
            _flag("release reverted");
        }
        _sweep();
    }

    function releaseNative(uint256 walletSeed, uint256 callerSeed) external {
        if (infos.length == 0) return;
        ArcVesting w = infos[walletSeed % infos.length].wallet;
        vm.prank(_actor(callerSeed));
        try w.release() {
            _flag("a native release succeeded");
        } catch (bytes memory why) {
            if (keccak256(why) != keccak256(abi.encodeWithSelector(ArcVesting.NativeValueNotSupported.selector))) {
                _flag("a native release failed for the wrong reason");
            }
            ++succeeded[this.releaseNative.selector];
        }
        _sweep();
    }

    function donate(uint256 walletSeed, uint256 actorSeed, uint256 amountSeed) external {
        if (infos.length == 0) return;
        WalletInfo storage w = infos[walletSeed % infos.length];
        IERC20 token = tokenAt(w.tokenIdx);
        uint256 amount = bound(amountSeed, 1, 1e24);
        uint256 before = token.balanceOf(address(w.wallet));
        vm.prank(_actor(actorSeed));
        if (!token.transfer(address(w.wallet), amount)) _flag("a donation failed");
        w.funded += token.balanceOf(address(w.wallet)) - before;
        ++succeeded[this.donate.selector];
        _sweep();
    }

    function transferOwnership(uint256 walletSeed, uint256 toSeed, uint256 callerSeed, bool asOwner) external {
        if (infos.length == 0) return;
        ArcVesting w = infos[walletSeed % infos.length].wallet;
        address owner_ = w.owner();
        address caller = asOwner ? owner_ : _nonOwner(callerSeed, owner_);
        address to = _actor(toSeed);
        vm.prank(caller);
        try w.transferOwnership(to) {
            if (caller != owner_) _flag("a non-owner transferred a wallet");
            if (w.owner() != to) _flag("the transfer did not take");
            ++succeeded[this.transferOwnership.selector];
        } catch {
            if (caller == owner_) _flag("the owner could not transfer");
            if (w.owner() != owner_) _flag("a failed transfer changed the owner");
        }
        _sweep();
    }

    function changeFee(uint256 valueSeed) external {
        uint256 cap = fees.capOf(KEY_VEST);
        uint256 value = bound(valueSeed, 0, cap);
        vm.prank(feeOwner);
        fees.setFee(KEY_VEST, value);
        (, uint64 at) = fees.pendingOf(KEY_VEST);
        if (at != 0 && block.timestamp >= at) fees.applyPending(KEY_VEST);
        ++succeeded[this.changeFee.selector];
        _sweep();
    }

    function warp(uint256 seed) external {
        vm.warp(block.timestamp + bound(seed, 1, 60 days));
        (, uint64 at) = fees.pendingOf(KEY_VEST);
        if (at != 0 && block.timestamp >= at) fees.applyPending(KEY_VEST);
        ++succeeded[this.warp.selector];
        _sweep();
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    /// After every action: what has vested never goes down.
    function _sweep() internal {
        for (uint256 i; i < infos.length; ++i) {
            WalletInfo storage w = infos[i];
            uint256 vested = w.wallet.vestedAmount(address(tokenAt(w.tokenIdx)), uint64(block.timestamp));
            if (vested < w.lastVested) {
                vestedDecreased = true;
                reason = "vested decreased";
            }
            w.lastVested = vested;
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _nonOwner(uint256 seed, address owner_) internal view returns (address) {
        address a = _actor(seed);
        return a == owner_ ? _actor(seed % actors.length + 1) : a;
    }

    function _flag(string memory why) internal {
        if (!unexpectedOutcome) reason = why;
        unexpectedOutcome = true;
    }
}

/// forge-config: default.invariant.runs = 500
/// forge-config: default.invariant.depth = 64
/// forge-config: default.invariant.fail-on-revert = true
contract VestingInvariantsTest is Test {
    VestingHandler internal handler;
    FeeController internal fees;
    VestingFactory internal factory;
    MockToken internal plain;
    MockFeeOnTransferToken internal taxed;
    address internal feeOwner = makeAddr("feeOwner");
    address payable internal feeRecipient = payable(makeAddr("feeRecipient"));

    function setUp() public {
        vm.warp(1_800_000_000);
        fees = new FeeController(feeOwner, feeRecipient);
        vm.prank(feeOwner);
        fees.addKey(keccak256("VEST_FLAT"), 20 ether, 100 ether);
        factory = new VestingFactory(fees);
        plain = new MockToken();
        taxed = new MockFeeOnTransferToken(100);
        handler = new VestingHandler(fees, factory, feeOwner, feeRecipient, plain, taxed);
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](9);
        selectors[0] = VestingHandler.create.selector;
        selectors[1] = VestingHandler.createInvalid.selector;
        selectors[2] = VestingHandler.release.selector;
        selectors[3] = VestingHandler.releaseNative.selector;
        selectors[4] = VestingHandler.donate.selector;
        selectors[5] = VestingHandler.transferOwnership.selector;
        selectors[6] = VestingHandler.changeFee.selector;
        selectors[7] = VestingHandler.warp.selector;
        selectors[8] = VestingHandler.release.selector; // releases twice as often
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// released + releasable + unreleased == funded, for every wallet: the wallet's balance plus what it has released
    /// is exactly what arrived, and what it says has vested is the reference curve over that total.
    function invariant_releasedPlusHeldEqualsFunded() public view {
        uint256 n = handler.walletCount();
        for (uint256 i; i < n; ++i) {
            VestingHandler.WalletInfo memory w = handler.info(i);
            address token = address(handler.tokenAt(w.tokenIdx));
            uint256 released = w.wallet.released(token);
            uint256 releasable = w.wallet.releasable(token);
            uint256 held = IERC20(token).balanceOf(address(w.wallet));
            assertEq(released, w.released, "released() differs from the ledger");
            assertLe(releasable, held, "more releasable than held");
            uint256 unreleased = held - releasable;
            assertEq(released + releasable + unreleased, w.funded, "released + releasable + unreleased != funded");
            assertEq(released + releasable, handler.referenceVested(i, block.timestamp), "vested != reference");
        }
    }

    function invariant_nothingReleasedBeforeTheCliff() public view {
        uint256 n = handler.walletCount();
        for (uint256 i; i < n; ++i) {
            VestingHandler.WalletInfo memory w = handler.info(i);
            if (block.timestamp < w.wallet.cliff()) {
                address token = address(handler.tokenAt(w.tokenIdx));
                assertEq(w.wallet.released(token), 0, "released before the cliff");
                assertEq(w.wallet.releasable(token), 0, "releasable before the cliff");
            }
        }
    }

    function invariant_nothingMoreThanFunded() public view {
        uint256 n = handler.walletCount();
        uint256 plainReleased;
        for (uint256 i; i < n; ++i) {
            VestingHandler.WalletInfo memory w = handler.info(i);
            address token = address(handler.tokenAt(w.tokenIdx));
            uint256 released = w.wallet.released(token);
            assertLe(released, w.funded, "released more than funded");
            assertLe(w.wallet.vestedAmount(token, type(uint64).max), w.funded, "vests more than funded");
            if (w.tokenIdx == 0) plainReleased += released;
        }
        assertEq(handler.plainPaidToOwners(), plainReleased, "owners received other than what was released");
    }

    function invariant_factoryAndWalletsHoldNoValue_andTheFactoryHoldsNoTokens() public view {
        assertEq(plain.balanceOf(address(factory)), 0);
        assertEq(taxed.balanceOf(address(factory)), 0);
        assertEq(address(factory).balance, 0);
        assertEq(feeRecipient.balance, handler.feesPaid(), "fees forwarded != fees paid");
        uint256 n = handler.walletCount();
        for (uint256 i; i < n; ++i) {
            assertEq(address(handler.info(i).wallet).balance, 0, "a wallet holds native value");
            assertEq(handler.info(i).wallet.releasable(), 0);
        }
    }

    function invariant_registriesMatchTheLedger() public view {
        uint256 n = handler.walletCount();
        assertEq(factory.vestingsForTokenLength(address(plain)), handler.createdForToken(0));
        assertEq(factory.vestingsForTokenLength(address(taxed)), handler.createdForToken(1));
        for (uint256 a; a < handler.actorCount(); ++a) {
            address actor = handler.actorAt(a);
            assertEq(factory.vestingsOfLength(actor), handler.createdFor(actor));
        }
        for (uint256 i; i < n; ++i) {
            assertTrue(factory.isVesting(address(handler.info(i).wallet)));
        }
    }

    function invariant_noUnexpectedOutcome() public view {
        assertFalse(handler.unexpectedOutcome(), handler.reason());
        assertFalse(handler.vestedDecreased(), "vested decreased");
    }

    /// Not an invariant: runs every action once, in an order where each can succeed, so the handler's predictions are
    /// shown to hold on a known path and none of its actions is vacuous.
    function test_handler_everyActionRunsAndSucceeds() public {
        handler.create(0, 1, 0, 1_000 ether, block.timestamp, 2 * 100 days, 10 days); // plain, 100 days, from now
        handler.create(1, 2, 1, 1_000 ether, block.timestamp, 2 * 30 days, 0); // taxed, 30 days
        for (uint256 kind; kind < 7; ++kind) {
            handler.createInvalid(kind, kind, kind);
        }
        handler.release(0, 3); // before the cliff: nothing
        handler.warp(50 days);
        handler.release(0, 4); // by a stranger, half way
        handler.release(1, 0); // the taxed schedule has ended
        handler.releaseNative(0, 0);
        handler.donate(0, 2, 10 ether);
        handler.transferOwnership(0, 3, 0, true);
        handler.transferOwnership(0, 1, 2, false);
        handler.changeFee(5 ether);
        handler.warp(60 days);
        handler.release(0, 1);
        assertEq(handler.succeeded(VestingHandler.create.selector), 2);
        assertEq(handler.succeeded(VestingHandler.createInvalid.selector), 7);
        assertEq(handler.succeeded(VestingHandler.release.selector), 4);
        assertEq(handler.nonZeroReleases(), 3);
        assertEq(handler.succeeded(VestingHandler.releaseNative.selector), 1);
        assertEq(handler.succeeded(VestingHandler.donate.selector), 1);
        assertEq(handler.succeeded(VestingHandler.transferOwnership.selector), 1);
        assertEq(handler.succeeded(VestingHandler.changeFee.selector), 1);
        invariant_releasedPlusHeldEqualsFunded();
        invariant_nothingReleasedBeforeTheCliff();
        invariant_nothingMoreThanFunded();
        invariant_factoryAndWalletsHoldNoValue_andTheFactoryHoldsNoTokens();
        invariant_registriesMatchTheLedger();
        invariant_noUnexpectedOutcome();
        VestingHandler.WalletInfo memory w = handler.info(0);
        assertEq(w.wallet.released(address(plain)), w.funded, "the plain schedule ended and was released in full");
    }
}
