// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IFeeController} from "../interfaces/IFeeController.sol";
import {IV3PositionManager} from "./interfaces/IPositionManagers.sol";
import {LockVault} from "./LockVault.sol";
import {PositionVault} from "./PositionVault.sol";

/// @title VaultFactory
/// @notice Creates one vault clone per lock and keeps the registry Inspector reads. Assets go straight from
/// the user to their vault; the factory never holds them. The owner can only allow-list position managers:
/// it has no power over any vault.
/// @dev Fees come from a FeeController and are paid as native value (`msg.value`, 18 decimals), like the other
/// ARC.os contracts. The registries are discovery hints, not proofs. Anyone can lock any token for any owner by
/// paying the flat fee, so a registry can be padded with entries nobody wants; read it in pages (`...Length` and
/// `...Slice`) and ask each vault for its own state. `isVault` is the only authoritative "is this ours" check:
/// anyone can clone the public implementation, and such a clone is not registered here.
contract VaultFactory is Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    bytes32 public constant LOCK_FLAT = keccak256("LOCK_FLAT");
    bytes32 public constant LOCK_LP_BPS = keccak256("LOCK_LP_BPS");
    bytes32 public constant LOCK_FEE_SHARE_BPS = keccak256("LOCK_FEE_SHARE_BPS");
    uint256 private constant BPS_DENOMINATOR = 10_000;

    IFeeController public immutable feeController;
    address public immutable lockVaultImpl;
    address public immutable positionVaultImpl;

    struct Manager {
        bool allowed;
        PositionVault.Kind kind;
    }

    mapping(address manager => Manager) public managers;
    mapping(address vault => bool) public isVault;
    mapping(address owner => address[]) private _vaultsOf;
    mapping(address token => address[]) private _vaultsForToken; // ERC-20 locks, keyed by the locked token
    mapping(address token => address[]) private _positionVaultsForToken; // position locks, keyed by either currency

    event ManagerSet(address indexed manager, bool allowed, PositionVault.Kind kind);
    event TokenLocked(
        address indexed owner, address indexed token, address vault, uint256 amount, uint256 fee, uint64 unlockAt
    );
    event PositionLocked(
        address indexed owner, address indexed manager, uint256 indexed tokenId, address vault, uint64 unlockAt
    );

    error WrongFee(uint256 expected, uint256 sent);
    error FeeTransferFailed();
    error ManagerNotAllowed();
    error ZeroAmount();
    error ZeroFeeController();
    error FeeOutOfRange(bytes32 key, uint256 value);
    error NotAToken();

    constructor(address owner_, IFeeController feeController_) Ownable(owner_) {
        if (address(feeController_) == address(0)) revert ZeroFeeController();
        // Probe the fee keys now: an immutable feeController deployed before its keys exist would otherwise be
        // permanently dead (every lock would revert with UnknownKey forever), as in TokenFactory and Multisend.
        feeController_.feeOf(LOCK_FLAT);
        feeController_.feeOf(LOCK_LP_BPS);
        feeController_.feeOf(LOCK_FEE_SHARE_BPS);
        feeController = feeController_;
        // Both implementations are made here, so they always have code and are exactly this build's contracts.
        lockVaultImpl = address(new LockVault());
        positionVaultImpl = address(new PositionVault());
    }

    /// @notice Allows or disallows a position manager for new position locks, and says what kind it is. Existing
    /// position vaults keep the manager they were made with, whatever this says later.
    function setManager(address manager, bool allowed, PositionVault.Kind kind) external onlyOwner {
        managers[manager] = Manager(allowed, kind);
        emit ManagerSet(manager, allowed, kind);
    }

    /// @notice Locks `amount` of `token` for `owner_` until `unlockAt`, in a new vault made for this lock alone. The
    /// caller pays the flat fee as native value and approves this factory for `amount`. Tokens go from the caller
    /// straight to the vault (an LP token's percentage fee, if any, straight to the fee recipient) and never rest in
    /// the factory. The percentage fee applies to Uniswap-v2-style LP tokens only.
    /// @dev The LP fee is `floor(amount * LOCK_LP_BPS / 10_000)`: it rounds DOWN, so the platform never takes more
    /// than the stated share and the vault receives the remainder, `amount - fee`. Below `10_000 / LOCK_LP_BPS` LP
    /// tokens (200 at 50 bps) the fee is zero. `feeOf` is read once per call and only the flat fee and this fee
    /// are ever charged: nothing is charged at withdrawal, and a later fee change never reaches an existing vault.
    function lockToken(IERC20 token, uint256 amount, uint64 unlockAt, address owner_)
        external
        payable
        nonReentrant
        returns (address vault)
    {
        address payable feeTo = feeController.recipient(); // read once: one call pays one recipient
        _takeFlatFee(feeTo);
        if (amount == 0) revert ZeroAmount();
        if (address(token).code.length == 0) revert NotAToken();

        vault = Clones.clone(lockVaultImpl);
        LockVault(vault).initialize(owner_, token, unlockAt);
        _register(vault, owner_);
        _vaultsForToken[address(token)].push(vault);

        // The percentage applies to LP tokens only; a team-token lock pays the flat fee alone. It rounds down (see
        // above), by mulDiv so that no amount can overflow it.
        uint256 fee = _isV2Pair(address(token)) ? Math.mulDiv(amount, _bps(LOCK_LP_BPS), BPS_DENOMINATOR) : 0;
        if (fee != 0) token.safeTransferFrom(msg.sender, feeTo, fee);
        token.safeTransferFrom(msg.sender, vault, amount - fee);
        emit TokenLocked(owner_, address(token), vault, amount - fee, fee, unlockAt);
    }

    /// @notice Locks a concentrated-liquidity position NFT from an allow-listed manager in a new vault. The platform's
    /// share of collected fees is read now and copied into the vault, so a later fee change never touches this lock.
    /// @dev In this build the position vault is a placeholder whose `initialize` always reverts, so this function
    /// cannot create a vault yet.
    function lockPosition(address manager, uint256 tokenId, uint64 unlockAt, address owner_)
        external
        payable
        nonReentrant
        returns (address vault)
    {
        address payable feeTo = feeController.recipient(); // read once: one call pays one recipient
        _takeFlatFee(feeTo);
        Manager memory m = managers[manager];
        if (!m.allowed) revert ManagerNotAllowed();

        vault = Clones.clone(positionVaultImpl);
        PositionVault(payable(vault)).initialize(owner_, manager, tokenId, unlockAt, m.kind, _shareBps(), feeTo);
        _register(vault, owner_);
        IV3PositionManager(manager).safeTransferFrom(msg.sender, vault, tokenId);
        emit PositionLocked(owner_, manager, tokenId, vault, unlockAt);
    }

    /// @notice Every vault made for `owner_` at creation, in order. Unbounded: prefer `vaultsOfLength` and
    /// `vaultsOfSlice`. After a vault's ownership moves, the vault's own `owner()` is the truth and this list is a
    /// discovery hint; read `owner()` for every vault it returns.
    function vaultsOf(address owner_) external view returns (address[] memory) {
        return _vaultsOf[owner_];
    }

    /// @notice Every ERC-20 vault made for `token`, in order. Unbounded: prefer the length and slice getters.
    function vaultsForToken(address token) external view returns (address[] memory) {
        return _vaultsForToken[token];
    }

    /// @notice Every position vault whose pool has `token` as a currency, in order. Unbounded: prefer the length and
    /// slice getters.
    function positionVaultsForToken(address token) external view returns (address[] memory) {
        return _positionVaultsForToken[token];
    }

    /// @notice The number of entries `vaultsOf(owner_)` would return.
    function vaultsOfLength(address owner_) external view returns (uint256) {
        return _vaultsOf[owner_].length;
    }

    function vaultsForTokenLength(address token) external view returns (uint256) {
        return _vaultsForToken[token].length;
    }

    function positionVaultsForTokenLength(address token) external view returns (uint256) {
        return _positionVaultsForToken[token].length;
    }

    /// @notice Up to `count` entries of `vaultsOf(owner_)` from index `start`, in order. The slice stops at the end
    /// of the list, and a `start` at or past the end returns an empty array: it never reverts. The same holds for
    /// `vaultsForTokenSlice` and `positionVaultsForTokenSlice`.
    function vaultsOfSlice(address owner_, uint256 start, uint256 count) external view returns (address[] memory) {
        return _slice(_vaultsOf[owner_], start, count);
    }

    function vaultsForTokenSlice(address token, uint256 start, uint256 count) external view returns (address[] memory) {
        return _slice(_vaultsForToken[token], start, count);
    }

    function positionVaultsForTokenSlice(address token, uint256 start, uint256 count)
        external
        view
        returns (address[] memory)
    {
        return _slice(_positionVaultsForToken[token], start, count);
    }

    function _slice(address[] storage all, uint256 start, uint256 count) private view returns (address[] memory) {
        uint256 len = all.length;
        if (start >= len) return new address[](0);
        uint256 remaining = len - start;
        // Compare before adding: `count` may be arbitrarily large (even type(uint256).max), and start + count
        // must not be computed when it would overflow.
        uint256 end = count > remaining ? len : start + count;
        address[] memory out = new address[](end - start);
        for (uint256 i = start; i < end; ++i) {
            out[i - start] = all[i];
        }
        return out;
    }

    /// @dev A basis-points fee from the controller. Anything above 100% is a misconfiguration and reverts, so a bad
    /// value can neither underflow a split nor be truncated by a narrower cast.
    function _bps(bytes32 key) private view returns (uint256 bps) {
        bps = feeController.feeOf(key);
        if (bps > BPS_DENOMINATOR) revert FeeOutOfRange(key, bps);
    }

    /// @dev The platform's share of a position's collected fees, copied into the position vault when it is made.
    function _shareBps() private view returns (uint16) {
        // casting to 'uint16' is safe because _bps never returns more than BPS_DENOMINATOR (10,000)
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint16(_bps(LOCK_FEE_SHARE_BPS));
    }

    function _register(address vault, address owner_) private {
        isVault[vault] = true;
        _vaultsOf[owner_].push(vault);
    }

    function _takeFlatFee(address payable feeTo) private {
        uint256 fee = feeController.feeOf(LOCK_FLAT);
        if (msg.value != fee) revert WrongFee(fee, msg.value);
        (bool ok,) = feeTo.call{value: fee}("");
        if (!ok) revert FeeTransferFailed();
    }

    /// @dev A Uniswap-v2-style pair answers token0(), token1() and getReserves(). An LP token can't hide this
    /// interface, and nobody gains by faking it (it only adds a fee).
    function _isV2Pair(address token) private view returns (bool) {
        (bool a, bytes memory ra) = token.staticcall(abi.encodeWithSignature("token0()"));
        (bool b, bytes memory rb) = token.staticcall(abi.encodeWithSignature("token1()"));
        (bool c, bytes memory rc) = token.staticcall(abi.encodeWithSignature("getReserves()"));
        return a && b && c && ra.length == 32 && rb.length == 32 && rc.length == 96;
    }
}
