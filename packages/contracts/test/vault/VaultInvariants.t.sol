// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {FeeController} from "../../src/FeeController.sol";
import {LockVault} from "../../src/vault/LockVault.sol";
import {VaultFactory} from "../../src/vault/VaultFactory.sol";
import {VaultTestBase} from "./VaultTestBase.sol";
import {MockToken, MockV2Pair} from "./mocks/VaultMocks.sol";

/// Drives random sequences of lock, extend, withdraw, ownership transfer, donation, time passing and fee changes by
/// random actors, and keeps an exact ledger of what every vault must hold.
///
/// `fail_on_revert` is off, so a handler that let a call revert would hide a bug. Every action therefore predicts
/// its own outcome from the vault's live owner, pending owner, unlock time and the clock, and sets a flag that never
/// clears when the real outcome differs (a call that should have reverted succeeded, one that should have succeeded
/// reverted, a revert moved tokens or changed state).
contract VaultHandler is Test {
    using SafeCast for uint256;

    uint64 internal constant MAX_DURATION = 3650 days;
    bytes32 internal constant KEY_FLAT = keccak256("LOCK_FLAT");
    bytes32 internal constant KEY_LP = keccak256("LOCK_LP_BPS");
    bytes32 internal constant KEY_SHARE = keccak256("LOCK_FEE_SHARE_BPS");

    FeeController public immutable fees;
    VaultFactory public immutable factory;
    address public immutable feeOwner;
    address payable public immutable feeRecipient;
    IERC20 public immutable plain; // token 0: a plain ERC-20
    IERC20 public immutable lp; // token 1: pair-shaped, so the LP fee applies
    address public immutable stranger; // never owns anything
    address[] internal actors;

    struct VaultInfo {
        address vault;
        address creationOwner;
        uint8 tokenIdx;
        uint256 ownerIndex; // position in factory.vaultsOf(creationOwner)
        uint256 tokenIndex; // position in factory.vaultsForToken(token)
        uint256 expected; // exactly what the vault must hold
        uint64 lastUnlockAt;
    }

    VaultInfo[] internal infos;

    // Ledger, per token index.
    uint256[2] public paid; // what lockers sent in (fee included)
    uint256[2] public locked; // what vaults recorded as received
    uint256[2] public feesTaken; // what went to the fee recipient as the LP fee
    uint256[2] public donated; // tokens sent straight to a vault
    uint256[2] public withdrawn; // tokens the owners took out
    uint256[2] public createdForToken;
    mapping(address owner => uint256) public createdFor;

    // How often each action really ran and succeeded, so the suite can show it is not vacuous.
    mapping(bytes4 selector => uint256) public succeeded;

    // Sticky flags.
    bool public unexpectedOutcome;
    bool public nonOwnerMovedTokens;
    bool public unlockAtDecreased;
    bool public tokensLeftAfterWithdraw;
    string public reason;

    constructor(
        FeeController fees_,
        VaultFactory factory_,
        address feeOwner_,
        address payable feeRecipient_,
        MockToken plain_,
        MockV2Pair lp_
    ) {
        fees = fees_;
        factory = factory_;
        feeOwner = feeOwner_;
        feeRecipient = feeRecipient_;
        plain = IERC20(address(plain_));
        lp = IERC20(address(lp_));
        stranger = makeAddr("handlerStranger");
        for (uint256 i; i < 4; ++i) {
            address actor = makeAddr(string.concat("handlerActor", vm.toString(i)));
            actors.push(actor);
            vm.deal(actor, 1e24);
            plain_.mint(actor, 1e30);
            lp_.mint(actor, 1e30);
            vm.startPrank(actor);
            plain_.approve(address(factory_), type(uint256).max);
            lp_.approve(address(factory_), type(uint256).max);
            vm.stopPrank();
        }
    }

    // ---------------------------------------------------------------------
    // Views for the invariants
    // ---------------------------------------------------------------------

    function vaultCount() external view returns (uint256) {
        return infos.length;
    }

    function info(uint256 i) external view returns (VaultInfo memory) {
        return infos[i];
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function actorAt(uint256 i) external view returns (address) {
        return actors[i];
    }

    function tokenAt(uint8 i) public view returns (IERC20) {
        return i == 0 ? plain : lp;
    }

    // ---------------------------------------------------------------------
    // Actions
    // ---------------------------------------------------------------------

    /// What one `lock` call will do, worked out before the call so the outcome can be checked against it.
    struct LockPlan {
        address user;
        address owner;
        uint8 tokenIdx;
        uint256 amount;
        uint64 unlockAt;
        uint256 flat;
        uint256 expectedFee;
    }

    function lock(uint256 actorSeed, uint256 tokenSeed, uint256 ownerSeed, uint256 amountSeed, uint256 durationSeed)
        external
    {
        LockPlan memory plan;
        plan.user = _actor(actorSeed);
        plan.tokenIdx = tokenSeed % 2 == 0 ? 0 : 1;
        uint256 balance = tokenAt(plan.tokenIdx).balanceOf(plan.user);
        if (balance == 0) return;
        plan.amount = bound(amountSeed, 1, balance);
        // Half the locks are short, so that many expire inside one run and the withdraw-after-unlock path is exercised.
        uint256 duration = durationSeed % 2 == 0
            ? bound(durationSeed / 2, 1 hours, 120 days)
            : bound(durationSeed / 2, 1, MAX_DURATION);
        plan.unlockAt = (block.timestamp + duration).toUint64();
        plan.owner = _actor(ownerSeed);
        plan.flat = fees.feeOf(KEY_FLAT);
        plan.expectedFee = plan.tokenIdx == 1 ? _floorBps(plan.amount, fees.feeOf(KEY_LP)) : 0;
        _lock(plan);
    }

    function _lock(LockPlan memory plan) internal {
        IERC20 token = tokenAt(plan.tokenIdx);
        uint256 recipientTokens = token.balanceOf(feeRecipient);
        uint256 recipientNative = feeRecipient.balance;
        uint256 ownerIndex = factory.vaultsOfLength(plan.owner);
        uint256 tokenIndex = factory.vaultsForTokenLength(address(token));

        vm.prank(plan.user);
        try factory.lockToken{value: plan.flat}(token, plan.amount, plan.unlockAt, plan.owner) returns (address vault) {
            uint256 got = token.balanceOf(vault);
            if (got != plan.amount - plan.expectedFee) _flag("a new vault does not hold amount minus the floor fee");
            if (token.balanceOf(feeRecipient) - recipientTokens != plan.expectedFee) {
                _flag("the LP fee is not the floor");
            }
            if (feeRecipient.balance - recipientNative != plan.flat) _flag("the flat fee was not forwarded");
            LockVault made = LockVault(vault);
            if (made.owner() != plan.owner || made.pendingOwner() != address(0)) {
                _flag("a new vault has the wrong owner");
            }
            if (address(made.token()) != address(token) || made.unlockAt() != plan.unlockAt) {
                _flag("a new vault has the wrong token or unlock time");
            }
            paid[plan.tokenIdx] += plan.amount;
            locked[plan.tokenIdx] += got;
            feesTaken[plan.tokenIdx] += plan.expectedFee;
            createdFor[plan.owner] += 1;
            createdForToken[plan.tokenIdx] += 1;
            infos.push(VaultInfo(vault, plan.owner, plan.tokenIdx, ownerIndex, tokenIndex, got, plan.unlockAt));
            ++succeeded[this.lock.selector];
        } catch {
            _flag("lockToken reverted for valid arguments");
        }
    }

    function extend(uint256 vaultSeed, uint256 callerSeed, uint256 timeSeed, bool asOwner) external {
        if (infos.length == 0) return;
        LockVault v = LockVault(infos[vaultSeed % infos.length].vault);
        address owner_ = v.owner();
        address caller = asOwner ? owner_ : _nonOwner(callerSeed, owner_);
        uint64 current = v.unlockAt();
        uint256 nowTs = block.timestamp;
        uint64 candidate = bound(timeSeed, 0, nowTs + MAX_DURATION + 30 days).toUint64();
        bool shouldSucceed =
            caller == owner_ && candidate > current && candidate > nowTs && candidate <= nowTs + MAX_DURATION;
        uint256[] memory before = _snapshot(address(v));

        vm.prank(caller);
        try v.extend(candidate) {
            if (!shouldSucceed) _flag("extend succeeded when it had to revert");
            else if (v.unlockAt() != candidate) _flag("extend did not set the new unlock time");
            else ++succeeded[this.extend.selector];
        } catch {
            if (shouldSucceed) _flag("extend reverted when it had to succeed");
            else if (v.unlockAt() != current) _flag("a reverted extend changed the unlock time");
        }
        _checkTokensUnmoved(before, address(v), caller != owner_, true);
        _checkUnlockAt(infos[vaultSeed % infos.length]);
    }

    function withdraw(uint256 vaultSeed, uint256 callerSeed, uint256 toSeed, bool asOwner) external {
        if (infos.length == 0) return;
        VaultInfo storage vi = infos[vaultSeed % infos.length];
        LockVault v = LockVault(vi.vault);
        address owner_ = v.owner();
        address caller = asOwner ? owner_ : _nonOwner(callerSeed, owner_);
        address to = _recipient(toSeed);
        IERC20 token = tokenAt(vi.tokenIdx);
        uint256 nowTs = block.timestamp;
        bool shouldSucceed = caller == owner_ && nowTs >= v.unlockAt();
        uint256 heldBefore = token.balanceOf(address(v));
        uint256 toBefore = token.balanceOf(to);
        uint256[] memory before = _snapshot(address(v));
        bool ok;

        vm.prank(caller);
        try v.withdraw(to) {
            ok = true;
            if (!shouldSucceed) {
                _flag("withdraw succeeded when it had to revert");
            } else {
                if (token.balanceOf(address(v)) != 0) tokensLeftAfterWithdraw = true;
                if (token.balanceOf(to) - toBefore != heldBefore) _flag("the recipient did not get the whole balance");
                withdrawn[vi.tokenIdx] += vi.expected;
                vi.expected = 0;
                ++succeeded[this.withdraw.selector];
            }
        } catch {
            if (shouldSucceed) _flag("withdraw reverted when it had to succeed");
        }
        // A non-owner call never moves a token, and neither does a call that reverted.
        _checkTokensUnmoved(before, address(v), caller != owner_, !ok);
        _checkUnlockAt(vi);
    }

    function transferOwnership(uint256 vaultSeed, uint256 callerSeed, uint256 toSeed, bool asOwner) external {
        if (infos.length == 0) return;
        LockVault v = LockVault(infos[vaultSeed % infos.length].vault);
        address owner_ = v.owner();
        address pendingBefore = v.pendingOwner();
        address caller = asOwner ? owner_ : _nonOwner(callerSeed, owner_);
        address to = toSeed % 5 == 0 ? address(0) : _anyone(toSeed);
        uint256[] memory before = _snapshot(address(v));

        vm.prank(caller);
        try v.transferOwnership(to) {
            if (caller != owner_) _flag("a non-owner started an ownership transfer");
            else if (v.pendingOwner() != to || v.owner() != owner_) _flag("transferOwnership left the wrong state");
            else ++succeeded[this.transferOwnership.selector];
        } catch {
            if (caller == owner_) {
                _flag("the owner's transferOwnership reverted");
            } else if (v.pendingOwner() != pendingBefore || v.owner() != owner_) {
                _flag("a reverted transfer changed state");
            }
        }
        _checkTokensUnmoved(before, address(v), caller != owner_, true);
        _checkUnlockAt(infos[vaultSeed % infos.length]);
    }

    function acceptOwnership(uint256 vaultSeed, uint256 callerSeed, bool asPending) external {
        if (infos.length == 0) return;
        LockVault v = LockVault(infos[vaultSeed % infos.length].vault);
        address owner_ = v.owner();
        address pending = v.pendingOwner();
        address caller = (asPending && pending != address(0)) ? pending : _anyone(callerSeed);
        bool shouldSucceed = pending != address(0) && caller == pending; // no caller is ever the zero address
        uint256[] memory before = _snapshot(address(v));

        vm.prank(caller);
        try v.acceptOwnership() {
            if (!shouldSucceed) {
                _flag("acceptOwnership succeeded for someone who is not the pending owner");
            } else if (v.owner() != caller || v.pendingOwner() != address(0)) {
                _flag("acceptOwnership left the wrong state");
            } else {
                ++succeeded[this.acceptOwnership.selector];
            }
        } catch {
            if (shouldSucceed) _flag("the pending owner could not accept");
            else if (v.owner() != owner_ || v.pendingOwner() != pending) _flag("a reverted accept changed state");
        }
        _checkTokensUnmoved(before, address(v), caller != owner_, true);
        _checkUnlockAt(infos[vaultSeed % infos.length]);
    }

    /// Tokens sent straight to a vault, by anyone, without the factory.
    function donate(uint256 vaultSeed, uint256 actorSeed, uint256 amountSeed) external {
        if (infos.length == 0) return;
        VaultInfo storage vi = infos[vaultSeed % infos.length];
        address user = _actor(actorSeed);
        IERC20 token = tokenAt(vi.tokenIdx);
        uint256 balance = token.balanceOf(user);
        if (balance == 0) return;
        uint256 amount = bound(amountSeed, 1, balance);
        vm.prank(user);
        if (!token.transfer(vi.vault, amount)) _flag("a donation failed");
        vi.expected += amount;
        donated[vi.tokenIdx] += amount;
        ++succeeded[this.donate.selector];
    }

    function warp(uint256 secondsSeed) external {
        vm.warp(block.timestamp + bound(secondsSeed, 1 hours, 90 days));
        ++succeeded[this.warp.selector];
    }

    /// The fee owner changes one fee: a decrease is immediate, an increase is scheduled and waits 48 hours. With
    /// `applyNow` the clock then moves past the delay and every pending increase is applied.
    function changeFee(uint256 keySeed, uint256 valueSeed, bool applyNow) external {
        bytes32 key = keySeed % 3 == 0 ? KEY_FLAT : keySeed % 3 == 1 ? KEY_LP : KEY_SHARE;
        uint256 value = bound(valueSeed, 0, fees.capOf(key));
        vm.prank(feeOwner);
        fees.setFee(key, value);
        if (applyNow) {
            vm.warp(block.timestamp + 48 hours);
            try fees.applyPending(KEY_FLAT) {} catch {}
            try fees.applyPending(KEY_LP) {} catch {}
            try fees.applyPending(KEY_SHARE) {} catch {}
        }
        ++succeeded[this.changeFee.selector];
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _flag(string memory why) internal {
        unexpectedOutcome = true;
        reason = why;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _anyone(uint256 seed) internal view returns (address) {
        uint256 i = seed % (actors.length + 1);
        return i == actors.length ? stranger : actors[i];
    }

    function _nonOwner(uint256 seed, address owner_) internal view returns (address) {
        uint256 start = seed % (actors.length + 1); // reduced first: the fuzzer does send type(uint256).max
        for (uint256 k; k <= actors.length; ++k) {
            address candidate = _anyone(start + k);
            if (candidate != owner_) return candidate;
        }
        revert("unreachable: there are more callers than one");
    }

    /// Where a withdrawal may go: never the vault, the factory or zero.
    function _recipient(uint256 seed) internal view returns (address) {
        uint256 i = seed % (actors.length + 2);
        if (i < actors.length) return actors[i];
        return i == actors.length ? stranger : feeRecipient;
    }

    /// floor(amount * bps / 10_000), by a route that shares nothing with the contract's mulDiv.
    function _floorBps(uint256 amount, uint256 bps) internal pure returns (uint256) {
        // Dividing first is exact here: amount = q * 10_000 + r, and r has its own term.
        // forge-lint: disable-next-line(divide-before-multiply)
        return (amount / 10_000) * bps + ((amount % 10_000) * bps) / 10_000;
    }

    /// The token balance, for both tokens, of every address a call on `vault` could plausibly move tokens between:
    /// the actors, the stranger, the fee recipient, the factory and the vault. A fixed size, whatever the run holds.
    function _snapshot(address vault) internal view returns (uint256[] memory s) {
        uint256 holders = actors.length + 4;
        s = new uint256[](holders * 2);
        for (uint8 t; t < 2; ++t) {
            IERC20 token = tokenAt(t);
            uint256 k = uint256(t) * holders;
            for (uint256 i; i < actors.length; ++i) {
                s[k++] = token.balanceOf(actors[i]);
            }
            s[k++] = token.balanceOf(stranger);
            s[k++] = token.balanceOf(feeRecipient);
            s[k++] = token.balanceOf(address(factory));
            s[k++] = token.balanceOf(vault);
        }
    }

    /// `nonOwnerCall`: the caller was not the vault's owner, so no token may have moved. `mustBeUnmoved`: the call
    /// reverted (or had to), so nothing may have moved. Every other vault is covered by the ledger invariant.
    function _checkTokensUnmoved(uint256[] memory before, address vault, bool nonOwnerCall, bool mustBeUnmoved)
        internal
    {
        if (!nonOwnerCall && !mustBeUnmoved) return;
        uint256[] memory afterwards = _snapshot(vault);
        for (uint256 i; i < before.length; ++i) {
            if (before[i] != afterwards[i]) {
                if (nonOwnerCall) nonOwnerMovedTokens = true;
                else _flag("a call that changed nothing moved tokens");
                return;
            }
        }
    }

    /// Reads a vault's unlock time and flags a decrease against the last reading.
    function _checkUnlockAt(VaultInfo storage vi) internal {
        uint64 current = LockVault(vi.vault).unlockAt();
        if (current < vi.lastUnlockAt) unlockAtDecreased = true;
        vi.lastUnlockAt = current;
    }
}

contract VaultInvariantsTest is VaultTestBase {
    VaultHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new VaultHandler(fees, factory, feeOwner, feeRecipient, token, pair);
        targetContract(address(handler));
        // Only the actions: the handler's view functions would just waste calls.
        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = VaultHandler.lock.selector;
        selectors[1] = VaultHandler.extend.selector;
        selectors[2] = VaultHandler.withdraw.selector;
        selectors[3] = VaultHandler.transferOwnership.selector;
        selectors[4] = VaultHandler.acceptOwnership.selector;
        selectors[5] = VaultHandler.donate.selector;
        selectors[6] = VaultHandler.warp.selector;
        selectors[7] = VaultHandler.changeFee.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // ---------------------------------------------------------------------
    // Invariants. Each `invariant_` function is its own campaign of random sequences, so related checks share one
    // pass over the vaults instead of each paying for a campaign.
    // ---------------------------------------------------------------------

    /// The tokens held by all vaults equal what was locked, plus what was sent in directly, minus what was
    /// withdrawn. The same pass checks each vault against the ledger, exactly, and that a vault that is still locked
    /// never holds less than the ledger says (nothing leaves early).
    function invariant_heldByVaultsEqualsLockedMinusWithdrawn() public view {
        uint256[2] memory held;
        uint256 n = handler.vaultCount();
        uint256 nowTs = block.timestamp;
        for (uint256 i; i < n; ++i) {
            VaultHandler.VaultInfo memory vi = handler.info(i);
            uint256 balance = handler.tokenAt(vi.tokenIdx).balanceOf(vi.vault);
            assertEq(balance, vi.expected, "a vault's balance drifted from the ledger");
            if (nowTs < LockVault(vi.vault).unlockAt()) assertGe(balance, vi.expected, "tokens left a locked vault");
            held[vi.tokenIdx] += balance;
        }
        for (uint8 t; t < 2; ++t) {
            uint256 want = handler.locked(t) + handler.donated(t) - handler.withdrawn(t);
            assertEq(held[t], want, "held by vaults != locked + donated - withdrawn");
        }
    }

    /// No vault ever holds tokens right after a withdraw.
    function invariant_noVaultHoldsTokensAfterAWithdraw() public view {
        assertFalse(handler.tokensLeftAfterWithdraw(), "a vault held tokens after a successful withdraw");
    }

    /// No call by a non-owner ever moves tokens.
    function invariant_noNonOwnerCallMovesTokens() public view {
        assertFalse(handler.nonOwnerMovedTokens(), "a non-owner call moved tokens");
    }

    /// `unlockAt` never decreases, for any vault.
    function invariant_unlockAtNeverDecreases() public view {
        assertFalse(handler.unlockAtDecreased(), "an unlock time went down");
        uint256 n = handler.vaultCount();
        for (uint256 i; i < n; ++i) {
            VaultHandler.VaultInfo memory vi = handler.info(i);
            assertGe(LockVault(vi.vault).unlockAt(), vi.lastUnlockAt, "an unlock time is below its last reading");
        }
    }

    /// Everything a locker sends is either locked or paid as the LP fee (nothing is created, lost or skimmed), and the
    /// factory never holds tokens or native value.
    function invariant_userFundsAreConserved_andTheFactoryHoldsNothing() public view {
        for (uint8 t; t < 2; ++t) {
            assertEq(handler.paid(t), handler.locked(t) + handler.feesTaken(t), "paid != locked + fees");
        }
        assertEq(address(factory).balance, 0, "the factory holds native value");
        assertEq(token.balanceOf(address(factory)), 0, "the factory holds the plain token");
        assertEq(pair.balanceOf(address(factory)), 0, "the factory holds the LP token");
    }

    /// Every vault is registered, once, where it was created, and the registry lengths match the ledger.
    function invariant_registriesMatchTheLedger() public view {
        uint256 n = handler.vaultCount();
        for (uint256 i; i < n; ++i) {
            VaultHandler.VaultInfo memory vi = handler.info(i);
            assertTrue(factory.isVault(vi.vault), "a created vault is not registered");
            address[] memory byOwner = factory.vaultsOfSlice(vi.creationOwner, vi.ownerIndex, 1);
            assertEq(byOwner.length, 1);
            assertEq(byOwner[0], vi.vault, "vaultsOf lists another vault at this index");
            address[] memory byToken =
                factory.vaultsForTokenSlice(address(handler.tokenAt(vi.tokenIdx)), vi.tokenIndex, 1);
            assertEq(byToken.length, 1);
            assertEq(byToken[0], vi.vault, "vaultsForToken lists another vault at this index");
        }
        for (uint256 a; a < handler.actorCount(); ++a) {
            address actor = handler.actorAt(a);
            assertEq(factory.vaultsOfLength(actor), handler.createdFor(actor), "vaultsOf length != ledger");
        }
        assertEq(factory.vaultsForTokenLength(address(token)), handler.createdForToken(0), "vaultsForToken(plain)");
        assertEq(factory.vaultsForTokenLength(address(pair)), handler.createdForToken(1), "vaultsForToken(pair)");
        assertEq(factory.positionVaultsForTokenLength(address(token)), 0, "nothing can fill the position registry yet");
    }

    /// Every action predicted its own outcome (who may call, when, what state results), and the prediction held.
    function invariant_noUnexpectedOutcome() public view {
        assertFalse(handler.unexpectedOutcome(), handler.reason());
    }

    // ---------------------------------------------------------------------
    // The handler itself must do real work
    // ---------------------------------------------------------------------

    /// A scripted run through every action. If a handler action stopped succeeding (a bad bound, a wrong
    /// prediction) the invariants above would still pass on an idle handler, so this pins that each one really runs.
    function test_handler_everyActionSucceedsOnAScriptedRun() public {
        handler.lock(0, 0, 1, 1e24, 100 days); // actor 0 locks the plain token for actor 1
        handler.lock(2, 1, 3, 5e21, 200 days); // actor 2 locks LP tokens for actor 3 (pays the LP fee)
        handler.donate(0, 2, 1e20);
        handler.extend(0, 0, block.timestamp + 150 days, true);
        handler.transferOwnership(0, 0, 2, true); // the owner nominates actor 2
        handler.acceptOwnership(0, 0, true); // and actor 2 accepts
        handler.changeFee(1, 100, true); // the LP fee goes to its cap of 100 bps, after the delay
        handler.warp(30 days);
        vm.warp(block.timestamp + 400 days); // past both unlock times (the handler's own warp stops at 90 days)
        handler.withdraw(0, 0, 1, true);
        handler.withdraw(1, 0, 1, true);

        assertFalse(handler.unexpectedOutcome(), handler.reason());
        assertFalse(handler.nonOwnerMovedTokens());
        assertFalse(handler.unlockAtDecreased());
        assertFalse(handler.tokensLeftAfterWithdraw());
        assertEq(handler.vaultCount(), 2);
        assertGt(handler.feesTaken(1), 0, "the LP fee was exercised");
        assertGt(handler.donated(0), 0);
        assertEq(handler.withdrawn(0), 1e24 + 1e20);
        for (uint256 i; i < 2; ++i) {
            VaultHandler.VaultInfo memory vi = handler.info(i);
            assertEq(vi.expected, 0, "a vault was withdrawn and is empty");
        }
        assertEq(handler.succeeded(VaultHandler.lock.selector), 2);
        assertEq(handler.succeeded(VaultHandler.extend.selector), 1);
        assertEq(handler.succeeded(VaultHandler.transferOwnership.selector), 1);
        assertEq(handler.succeeded(VaultHandler.acceptOwnership.selector), 1);
        assertEq(handler.succeeded(VaultHandler.withdraw.selector), 2);
        assertEq(handler.succeeded(VaultHandler.donate.selector), 1);
        assertEq(handler.succeeded(VaultHandler.warp.selector), 1);
        assertEq(handler.succeeded(VaultHandler.changeFee.selector), 1);
        assertEq(fees.feeOf(KEY_LP), 100, "the fee change was applied");
    }
}
