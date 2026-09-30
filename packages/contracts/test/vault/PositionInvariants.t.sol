// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {FeeController} from "../../src/FeeController.sol";
import {PositionVault} from "../../src/vault/PositionVault.sol";
import {VaultFactory} from "../../src/vault/VaultFactory.sol";
import {MockToken} from "./mocks/VaultMocks.sol";
import {
    MockHostileToken,
    MockSwitchableReceiver,
    MockV3PositionManager,
    MockV4PositionManager
} from "./mocks/PositionMocks.sol";

/// Drives random sequences of position locks, fee accrual, collect, extend, withdraw, ownership transfer, time passing,
/// a fee recipient that turns hostile and recovers, and direct attacks on the managers, by random actors. Three kinds of
/// pool are used: v3 (hostile token A / token B), v4 (A / B) and v4 native (native / A). Token A misbehaves towards
/// the fee recipient whenever the recipient is hostile.
///
/// `fail_on_revert` is on, so every call into the contracts under test is caught here, and each action predicts its
/// outcome (who may call, when, and exactly who is paid what) and sets a flag that never clears when the real outcome
/// differs.
contract PositionHandler is Test {
    using SafeCast for uint256;

    uint64 internal constant MAX_DURATION = 3650 days;
    uint128 public constant LIQUIDITY = 1e24;
    bytes32 internal constant KEY_FLAT = keccak256("LOCK_FLAT");
    bytes32 internal constant KEY_SHARE = keccak256("LOCK_FEE_SHARE_BPS");

    FeeController public immutable fees;
    VaultFactory public immutable factory;
    MockV3PositionManager public immutable v3;
    MockV4PositionManager public immutable v4;
    MockHostileToken public immutable tokenA;
    MockToken public immutable tokenB;
    MockSwitchableReceiver public immutable recipient;
    address public immutable feeOwner;
    address[] internal actors;

    struct Info {
        address vault;
        uint8 pool; // 0: v3 A/B, 1: v4 A/B, 2: v4 native/A
        uint256 id;
        uint16 share;
        uint64 lastUnlockAt;
        bool withdrawn;
        uint64 withdrawnAt; // the time of the withdraw
        uint64 unlockAtThen; // the unlock time when it happened
    }

    Info[] internal infos;
    bool public hostile;

    // Ledger.
    uint256 public platformNative; // share paid to the recipient in native value (flat fees excluded)
    uint256 public flatFees;
    uint256 public platformA;
    uint256 public platformB;
    uint256 public skips;
    mapping(bytes4 selector => uint256) public succeeded;

    // Sticky flags.
    bool public unexpectedOutcome;
    string public reason;

    constructor(
        FeeController fees_,
        VaultFactory factory_,
        MockV3PositionManager v3_,
        MockV4PositionManager v4_,
        MockHostileToken tokenA_,
        MockToken tokenB_,
        MockSwitchableReceiver recipient_,
        address feeOwner_
    ) {
        fees = fees_;
        factory = factory_;
        v3 = v3_;
        v4 = v4_;
        tokenA = tokenA_;
        tokenB = tokenB_;
        recipient = recipient_;
        feeOwner = feeOwner_;
        for (uint256 i; i < 4; ++i) {
            address actor = makeAddr(string.concat("positionActor", vm.toString(i)));
            actors.push(actor);
            vm.deal(actor, 1e24);
        }
        vm.deal(address(this), 1e30);
    }

    // ---------------------------------------------------------------------
    // Views for the invariants
    // ---------------------------------------------------------------------

    function count() external view returns (uint256) {
        return infos.length;
    }

    function info(uint256 i) external view returns (Info memory) {
        return infos[i];
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function actorAt(uint256 i) external view returns (address) {
        return actors[i];
    }

    function managerOf(uint8 pool) public view returns (address) {
        return pool == 0 ? address(v3) : address(v4);
    }

    function currenciesOf(uint8 pool) public view returns (address, address) {
        if (pool == 2) return (address(0), address(tokenA));
        return (address(tokenA), address(tokenB));
    }

    function liquidityOf(Info memory i) public view returns (uint128) {
        return i.pool == 0 ? v3.liquidityOf(i.id) : v4.getPositionLiquidity(i.id);
    }

    function ownerOfNft(Info memory i) public view returns (address) {
        return i.pool == 0 ? v3.ownerOf(i.id) : v4.ownerOf(i.id);
    }

    // ---------------------------------------------------------------------
    // Actions
    // ---------------------------------------------------------------------

    struct LockPlan {
        address user;
        address owner;
        uint8 pool;
        uint256 id;
        address manager;
        uint64 unlockAt;
        uint256 flat;
        uint16 share;
    }

    function lock(uint256 actorSeed, uint256 poolSeed, uint256 ownerSeed, uint256 durationSeed) external {
        // A recipient that refuses the flat fee blocks new locks (part 1's Q9). The factory forwards all gas with the
        // flat fee, so a gas-burning recipient would burn the whole test's gas: only the reverting one is tried.
        if (hostile && recipient.mode() != MockSwitchableReceiver.Mode.Revert) return;
        LockPlan memory p;
        p.user = _actor(actorSeed);
        p.owner = _actor(ownerSeed);
        p.pool = (poolSeed % 3).toUint8();
        (address c0, address c1) = currenciesOf(p.pool);
        p.id = p.pool == 0 ? v3.mint(p.user, c0, c1, LIQUIDITY) : v4.mint(p.user, c0, c1, LIQUIDITY);
        p.manager = managerOf(p.pool);
        vm.prank(p.user);
        MockV3PositionManager(p.manager).approve(address(factory), p.id); // same ERC-721 call on the v4 mock
        uint256 duration = durationSeed % 2 == 0
            ? bound(durationSeed / 2, 1 hours, 120 days)
            : bound(durationSeed / 2, 1, MAX_DURATION);
        p.unlockAt = (block.timestamp + duration).toUint64();
        p.flat = fees.feeOf(KEY_FLAT);
        p.share = fees.feeOf(KEY_SHARE).toUint16();
        _lock(p);
    }

    function _lock(LockPlan memory p) internal {
        bool shouldSucceed = !hostile;
        vm.prank(p.user);
        try factory.lockPosition{value: p.flat}(p.manager, p.id, p.unlockAt, p.owner) returns (address vault) {
            if (!shouldSucceed) {
                _flag("a lock paid a hostile recipient");
                return;
            }
            PositionVault v = PositionVault(payable(vault));
            Info memory made = Info(vault, p.pool, p.id, p.share, p.unlockAt, false, 0, 0);
            if (ownerOfNft(made) != vault) _flag("the NFT did not move into the vault");
            if (v.owner() != p.owner || v.unlockAt() != p.unlockAt || v.feeShareBps() != p.share) {
                _flag("a new vault is wrong");
            }
            flatFees += p.flat;
            infos.push(made);
            ++succeeded[this.lock.selector];
        } catch {
            if (shouldSucceed) _flag("lockPosition reverted for valid arguments");
        }
    }

    function accrue(uint256 vaultSeed, uint256 a0, uint256 a1) external {
        if (infos.length == 0) return;
        Info memory i = infos[vaultSeed % infos.length];
        uint128 x0 = bound(a0, 0, 1e24).toUint128();
        uint128 x1 = bound(a1, 0, 1e24).toUint128();
        if (i.pool == 0) v3.accrue(i.id, x0, x1);
        else v4.accrue{value: i.pool == 2 ? x0 : 0}(i.id, x0, x1);
        ++succeeded[this.accrue.selector];
    }

    /// What one currency's split must pay.
    struct Split {
        address currency;
        uint256 amount;
        uint256 toPlatform;
        bool skipped;
        uint256 ownerBefore;
        uint256 platformBefore;
    }

    function collect(uint256 vaultSeed, uint256 callerSeed, bool asOwner) external {
        if (infos.length == 0) return;
        Info memory i = infos[vaultSeed % infos.length];
        PositionVault v = PositionVault(payable(i.vault));
        address owner_ = v.owner();
        address caller = asOwner ? owner_ : _anyoneBut(callerSeed, owner_);
        bool shouldSucceed = caller == owner_ && !i.withdrawn;
        (Split memory s0, Split memory s1) = _plan(i, owner_);
        uint256[] memory others = _othersBalances(owner_);

        vm.prank(caller);
        try v.collect() {
            if (!shouldSucceed) {
                _flag("collect succeeded for a non-owner, or after withdraw");
                return;
            }
            _checkSplit(s0, owner_);
            _checkSplit(s1, owner_);
            ++succeeded[this.collect.selector];
        } catch {
            if (shouldSucceed) _flag("collect reverted for the owner");
        }
        _checkOthersUnpaid(others, owner_);
    }

    function extend(uint256 vaultSeed, uint256 callerSeed, uint256 timeSeed, bool asOwner) external {
        if (infos.length == 0) return;
        Info storage i = infos[vaultSeed % infos.length];
        PositionVault v = PositionVault(payable(i.vault));
        address owner_ = v.owner();
        address caller = asOwner ? owner_ : _anyoneBut(callerSeed, owner_);
        uint64 current = v.unlockAt();
        uint64 candidate = bound(timeSeed, 0, block.timestamp + MAX_DURATION + 30 days).toUint64();
        uint256 nowTs = block.timestamp;
        bool shouldSucceed =
            caller == owner_ && candidate > current && candidate > nowTs && candidate <= nowTs + MAX_DURATION;
        vm.prank(caller);
        try v.extend(candidate) {
            if (!shouldSucceed) {
                _flag("extend succeeded when it had to revert");
                return;
            }
            ++succeeded[this.extend.selector];
        } catch {
            if (shouldSucceed) _flag("extend reverted when it had to succeed");
        }
        if (v.unlockAt() < i.lastUnlockAt) _flag("unlockAt decreased");
        i.lastUnlockAt = v.unlockAt();
    }

    function withdraw(uint256 vaultSeed, uint256 callerSeed, uint256 toSeed, bool asOwner) external {
        if (infos.length == 0) return;
        Info storage i = infos[vaultSeed % infos.length];
        PositionVault v = PositionVault(payable(i.vault));
        address owner_ = v.owner();
        address caller = asOwner ? owner_ : _anyoneBut(callerSeed, owner_);
        address to = _actor(toSeed);
        uint256 nowTs = block.timestamp;
        bool shouldSucceed = caller == owner_ && nowTs >= v.unlockAt() && !i.withdrawn;
        vm.prank(caller);
        try v.withdraw(to) {
            if (!shouldSucceed) {
                _flag("withdraw succeeded when it had to revert");
                return;
            }
            if (ownerOfNft(i) != to) _flag("withdraw did not deliver the NFT");
            i.withdrawn = true;
            i.withdrawnAt = uint64(block.timestamp);
            i.unlockAtThen = v.unlockAt();
            ++succeeded[this.withdraw.selector];
        } catch {
            if (shouldSucceed) _flag("withdraw reverted when it had to succeed");
        }
    }

    function transferOwnership(uint256 vaultSeed, uint256 callerSeed, uint256 toSeed, bool asOwner) external {
        if (infos.length == 0) return;
        PositionVault v = PositionVault(payable(infos[vaultSeed % infos.length].vault));
        address owner_ = v.owner();
        address caller = asOwner ? owner_ : _anyoneBut(callerSeed, owner_);
        address to = _actor(toSeed);
        vm.prank(caller);
        try v.transferOwnership(to) {
            if (caller != owner_) {
                _flag("a non-owner started a transfer");
                return;
            }
            ++succeeded[this.transferOwnership.selector];
        } catch {
            if (caller == owner_) _flag("the owner could not start a transfer");
        }
    }

    function acceptOwnership(uint256 vaultSeed, uint256 callerSeed, bool asPending) external {
        if (infos.length == 0) return;
        PositionVault v = PositionVault(payable(infos[vaultSeed % infos.length].vault));
        address pending = v.pendingOwner();
        address caller = asPending && pending != address(0) ? pending : _anyoneBut(callerSeed, pending);
        bool shouldSucceed = caller == pending && pending != address(0);
        vm.prank(caller);
        try v.acceptOwnership() {
            if (!shouldSucceed) {
                _flag("acceptOwnership succeeded for the wrong caller");
                return;
            }
            ++succeeded[this.acceptOwnership.selector];
        } catch {
            if (shouldSucceed) _flag("the pending owner could not accept");
        }
    }

    /// Anyone, the vault's own owner included, tries to take the principal straight from the manager: decrease
    /// liquidity, transfer or approve the NFT, or collect to themselves. The vault is the NFT's owner and approves
    /// nobody, so every attempt must fail, before and after the unlock time.
    function attack(uint256 vaultSeed, uint256 actorSeed, uint256 how) external {
        if (infos.length == 0) return;
        Info memory i = infos[vaultSeed % infos.length];
        if (i.withdrawn) return;
        address attacker = _actor(actorSeed);
        vm.startPrank(attacker);
        bool ok = i.pool == 0 ? _attackV3(i, attacker, how % 4) : _attackV4(i, attacker, how % 3);
        vm.stopPrank();
        if (ok) _flag("an attack on the manager succeeded");
        ++succeeded[this.attack.selector];
    }

    function _attackV3(Info memory i, address attacker, uint256 k) internal returns (bool ok) {
        bytes memory data;
        if (k == 0) {
            data = abi.encodeCall(
                MockV3PositionManager.decreaseLiquidity,
                (MockV3PositionManager.DecreaseLiquidityParams(i.id, 1, 0, 0, block.timestamp))
            );
        } else if (k == 1) {
            data = abi.encodeWithSignature("transferFrom(address,address,uint256)", i.vault, attacker, i.id);
        } else if (k == 2) {
            data = abi.encodeWithSignature("approve(address,uint256)", attacker, i.id);
        } else {
            data = abi.encodeCall(
                MockV3PositionManager.collect,
                (MockV3PositionManager.CollectParams(i.id, attacker, type(uint128).max, type(uint128).max))
            );
        }
        (ok,) = address(v3).call(data);
    }

    function _attackV4(Info memory i, address attacker, uint256 k) internal returns (bool ok) {
        bytes memory data;
        if (k == 0) {
            (address c0, address c1) = currenciesOf(i.pool);
            bytes[] memory params = new bytes[](2);
            params[0] = abi.encode(i.id, uint256(1), uint128(0), uint128(0), bytes(""));
            params[1] = abi.encode(c0, c1, attacker);
            bytes memory unlockData = abi.encode(abi.encodePacked(uint8(0x01), uint8(0x11)), params);
            data = abi.encodeCall(MockV4PositionManager.modifyLiquidities, (unlockData, block.timestamp));
        } else if (k == 1) {
            data = abi.encodeWithSignature("transferFrom(address,address,uint256)", i.vault, attacker, i.id);
        } else {
            data = abi.encodeWithSignature("approve(address,uint256)", attacker, i.id);
        }
        (ok,) = address(v4).call(data);
    }

    /// The fee recipient turns hostile (it refuses native value, and token A refuses to pay it) or recovers. Each
    /// kind of hostility is tried: revert, burn all gas, revert with a megabyte.
    function setHostile(uint256 modeSeed) external {
        uint256 m = modeSeed % 4;
        hostile = m != 0;
        if (m == 0) {
            recipient.setMode(MockSwitchableReceiver.Mode.Accept);
            tokenA.setMode(address(recipient), MockHostileToken.Mode.None);
        } else if (m == 1) {
            recipient.setMode(MockSwitchableReceiver.Mode.Revert);
            tokenA.setMode(
                address(recipient), modeSeed % 8 < 4 ? MockHostileToken.Mode.Revert : MockHostileToken.Mode.ReturnFalse
            );
        } else if (m == 2) {
            recipient.setMode(MockSwitchableReceiver.Mode.BurnGas);
            tokenA.setMode(address(recipient), MockHostileToken.Mode.BurnGas);
        } else {
            recipient.setMode(MockSwitchableReceiver.Mode.ReturnBomb);
            tokenA.setMode(address(recipient), MockHostileToken.Mode.ReturnBomb);
        }
        ++succeeded[this.setHostile.selector];
    }

    /// The share for NEW locks changes; existing vaults keep theirs.
    function changeShare(uint256 valueSeed) external {
        uint256 value = bound(valueSeed, 0, 500);
        vm.prank(feeOwner);
        fees.setFee(KEY_SHARE, value);
        (uint256 pending, uint64 at) = fees.pendingOf(KEY_SHARE);
        if (at != 0) {
            vm.warp(at);
            fees.applyPending(KEY_SHARE);
            if (pending != value) _flag("pending share mismatch");
        }
        ++succeeded[this.changeShare.selector];
    }

    function warp(uint256 secondsSeed) external {
        vm.warp(block.timestamp + bound(secondsSeed, 1, 90 days));
        ++succeeded[this.warp.selector];
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _plan(Info memory i, address owner_) internal view returns (Split memory s0, Split memory s1) {
        (address c0, address c1) = currenciesOf(i.pool);
        (uint128 owed0, uint128 owed1) = i.pool == 0 ? v3.owedOf(i.id) : v4.owedOf(i.id);
        s0 = _planOne(c0, owed0 + _balance(c0, i.vault), i.share, owner_);
        s1 = _planOne(c1, owed1 + _balance(c1, i.vault), i.share, owner_);
    }

    function _planOne(address currency, uint256 amount, uint16 share, address owner_)
        internal
        view
        returns (Split memory s)
    {
        s.currency = currency;
        s.amount = amount;
        s.toPlatform = (amount * share) / 10_000;
        // Token B always pays; native value and token A fail towards a hostile recipient.
        s.skipped = s.toPlatform != 0 && hostile && currency != address(tokenB);
        s.ownerBefore = _balance(currency, owner_);
        s.platformBefore = _balance(currency, address(recipient));
    }

    function _checkSplit(Split memory s, address owner_) internal {
        uint256 platform = _balance(s.currency, address(recipient)) - s.platformBefore;
        uint256 ownerGot = _balance(s.currency, owner_) - s.ownerBefore;
        uint256 expectedPlatform = s.skipped ? 0 : s.toPlatform;
        if (platform != expectedPlatform) _flag("the platform was paid the wrong amount");
        if (ownerGot != s.amount - expectedPlatform) _flag("the owner was paid the wrong amount");
        if (s.skipped) ++skips;
        if (s.currency == address(0)) platformNative += platform;
        else if (s.currency == address(tokenA)) platformA += platform;
        else platformB += platform;
    }

    function _othersBalances(address owner_) internal view returns (uint256[] memory b) {
        b = new uint256[](actors.length * 3);
        for (uint256 k; k < actors.length; ++k) {
            if (actors[k] == owner_) continue;
            b[k * 3] = actors[k].balance;
            b[k * 3 + 1] = tokenA.balanceOf(actors[k]);
            b[k * 3 + 2] = tokenB.balanceOf(actors[k]);
        }
    }

    function _checkOthersUnpaid(uint256[] memory b, address owner_) internal {
        for (uint256 k; k < actors.length; ++k) {
            if (actors[k] == owner_) continue;
            if (
                actors[k].balance != b[k * 3] || tokenA.balanceOf(actors[k]) != b[k * 3 + 1]
                    || tokenB.balanceOf(actors[k]) != b[k * 3 + 2]
            ) _flag("someone other than the owner was paid by collect");
        }
    }

    function _balance(address currency, address who) internal view returns (uint256) {
        return currency == address(0) ? who.balance : IERC20(currency).balanceOf(who);
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    /// Any actor but `who`, or a stranger if every actor is `who`.
    function _anyoneBut(uint256 seed, address who) internal returns (address a) {
        a = actors[seed % actors.length];
        if (a == who) a = actors[(seed % actors.length + 1) % actors.length];
        if (a == who) a = makeAddr("positionStranger");
    }

    function _flag(string memory why) internal {
        if (!unexpectedOutcome) reason = why;
        unexpectedOutcome = true;
    }
}

/// The audit's two facts for position locks, as invariants over the handler above: the principal (the liquidity and
/// the NFT) of a locked position cannot leave before `unlockAt`, and nobody but the owner can collect or withdraw.
/// 1000 runs of 64 calls per invariant (6 invariants: 384,000 handler calls, about 20 s on four cores).
/// forge-config: default.invariant.runs = 1000
/// forge-config: default.invariant.depth = 64
contract PositionInvariantsTest is Test {
    uint256 internal constant FLAT = 30 ether;

    PositionHandler internal handler;
    FeeController internal fees;
    VaultFactory internal factory;
    MockV3PositionManager internal v3;
    MockV4PositionManager internal v4;
    MockSwitchableReceiver internal recipient;

    function setUp() public {
        address feeOwner = makeAddr("feeOwner");
        recipient = new MockSwitchableReceiver();
        fees = new FeeController(feeOwner, payable(address(recipient)));
        vm.startPrank(feeOwner);
        fees.addKey(keccak256("LOCK_FLAT"), FLAT, 150 ether);
        fees.addKey(keccak256("LOCK_LP_BPS"), 50, 100);
        fees.addKey(keccak256("LOCK_FEE_SHARE_BPS"), 200, 500);
        vm.stopPrank();
        address factoryOwner = makeAddr("factoryOwner");
        factory = new VaultFactory(factoryOwner, fees);
        v3 = new MockV3PositionManager();
        v4 = new MockV4PositionManager();
        vm.startPrank(factoryOwner);
        factory.setManager(address(v3), true, PositionVault.Kind.V3);
        factory.setManager(address(v4), true, PositionVault.Kind.V4);
        vm.stopPrank();
        handler =
            new PositionHandler(fees, factory, v3, v4, new MockHostileToken(), new MockToken(), recipient, feeOwner);
        targetContract(address(handler));
    }

    /// Before its unlock time, every locked position is held by its vault; the NFT leaves only by `withdraw`, at or
    /// after the unlock time, to where the owner said.
    function invariant_theNftStaysInTheVaultUntilWithdrawn() public view {
        for (uint256 k; k < handler.count(); ++k) {
            PositionHandler.Info memory i = handler.info(k);
            if (!i.withdrawn) assertEq(handler.ownerOfNft(i), i.vault, "a locked NFT left its vault");
            // (An emptied vault can still be extended, so its unlock time now says nothing; the time of the withdraw
            // is compared with the unlock time of that moment.)
            if (i.withdrawn) assertGe(i.withdrawnAt, i.unlockAtThen, "withdrawn before the unlock time");
        }
    }

    /// No position's liquidity ever goes down: the vault only decreases by zero, and nobody else can decrease at all.
    function invariant_liquidityNeverDecreases() public view {
        for (uint256 k; k < handler.count(); ++k) {
            assertEq(handler.liquidityOf(handler.info(k)), handler.LIQUIDITY(), "principal left a position");
        }
    }

    /// An unlock time never goes down.
    function invariant_unlockAtNeverDecreases() public view {
        for (uint256 k; k < handler.count(); ++k) {
            PositionHandler.Info memory i = handler.info(k);
            assertGe(PositionVault(payable(i.vault)).unlockAt(), i.lastUnlockAt);
        }
    }

    /// The recipient's receipts are exactly the flat fees plus the shares the handler predicted, and no vault keeps
    /// fees after a collect (the vault never holds anything between calls in this suite).
    function invariant_theRecipientGetsExactlyItsShares() public view {
        assertEq(recipient.received(), handler.flatFees() + handler.platformNative(), "native to the recipient");
        for (uint256 k; k < handler.count(); ++k) {
            address v = handler.info(k).vault;
            assertEq(v.balance, 0, "a vault keeps native value");
        }
    }

    /// Every vault is registered under both of its pool's currencies.
    function invariant_everyVaultIsRegisteredUnderBothCurrencies() public view {
        for (uint256 k; k < handler.count(); ++k) {
            PositionHandler.Info memory i = handler.info(k);
            (address c0, address c1) = handler.currenciesOf(i.pool);
            assertTrue(_listed(c0, i.vault) && _listed(c1, i.vault), "a vault is missing from the registry");
            assertTrue(factory.isVault(i.vault));
        }
    }

    function _listed(address currency, address vault) internal view returns (bool) {
        address[] memory all = factory.positionVaultsForToken(currency);
        for (uint256 k; k < all.length; ++k) {
            if (all[k] == vault) return true;
        }
        return false;
    }

    /// Every action predicted its own outcome, including exactly who is paid what by collect, and the prediction held.
    function invariant_noUnexpectedOutcome() public view {
        assertFalse(handler.unexpectedOutcome(), handler.reason());
    }

    /// A scripted run through every action, so an idle handler cannot pass the invariants vacuously.
    function test_handler_everyActionSucceedsOnAScriptedRun() public {
        handler.lock(0, 0, 1, 2 * 10 days); // v3, for actor 1
        handler.lock(1, 1, 2, 2 * 10 days); // v4 A/B, for actor 2
        handler.lock(2, 2, 3, 2 * 10 days); // v4 native/A, for actor 3
        for (uint256 k; k < 3; ++k) {
            handler.accrue(k, 1e20, 1e19);
            handler.collect(k, 0, true);
        }
        handler.setHostile(1); // the recipient reverts; token A reverts towards it
        for (uint256 k; k < 3; ++k) {
            handler.accrue(k, 1e20, 1e19);
            handler.collect(k, 0, true);
            handler.collect(k, 0, false); // a non-owner is refused
        }
        handler.setHostile(2); // gas burning
        handler.accrue(2, 1e20, 1e19);
        handler.collect(2, 0, true);
        handler.setHostile(3); // a megabyte of revert data
        handler.accrue(2, 1e20, 1e19);
        handler.collect(2, 0, true);
        handler.setHostile(0);
        for (uint256 h; h < 10; ++h) {
            handler.attack(h % 3, h, h);
        }
        handler.extend(0, 0, block.timestamp + 30 days, true);
        handler.transferOwnership(1, 0, 0, true);
        handler.acceptOwnership(1, 0, true);
        handler.changeShare(500);
        handler.lock(3, 0, 0, 2 * 10 days); // a new lock copies the new share
        handler.warp(90 days);
        handler.withdraw(1, 0, 3, true);
        handler.withdraw(2, 0, 3, false); // a non-owner is refused

        assertFalse(handler.unexpectedOutcome(), handler.reason());
        assertEq(handler.info(3).share, 500);
        assertGt(handler.skips(), 0, "a skip was exercised");
        assertGt(handler.platformA(), 0);
        assertGt(handler.platformB(), 0);
        assertGt(handler.platformNative(), 0);
        assertEq(handler.succeeded(PositionHandler.lock.selector), 4);
        assertEq(handler.succeeded(PositionHandler.collect.selector), 8);
        assertEq(handler.succeeded(PositionHandler.attack.selector), 10);
        assertEq(handler.succeeded(PositionHandler.extend.selector), 1);
        assertEq(handler.succeeded(PositionHandler.transferOwnership.selector), 1);
        assertEq(handler.succeeded(PositionHandler.acceptOwnership.selector), 1);
        assertEq(handler.succeeded(PositionHandler.withdraw.selector), 1);
        assertGe(handler.succeeded(PositionHandler.setHostile.selector), 4);
        assertEq(handler.succeeded(PositionHandler.changeShare.selector), 1);
        assertEq(handler.succeeded(PositionHandler.warp.selector), 1);
        invariant_theNftStaysInTheVaultUntilWithdrawn();
        invariant_liquidityNeverDecreases();
        invariant_theRecipientGetsExactlyItsShares();
        invariant_everyVaultIsRegisteredUnderBothCurrencies();
    }
}
