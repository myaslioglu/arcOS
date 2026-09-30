// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {FeeController} from "../src/FeeController.sol";
import {ProPass} from "../src/ProPass.sol";
import {VaultFactory} from "../src/vault/VaultFactory.sol";
import {PositionVault} from "../src/vault/PositionVault.sol";
import {VestingFactory} from "../src/vesting/VestingFactory.sol";

/// Usage: see DEPLOY.md, "R1". Adds R1's five fee keys to R0's FeeController, deploys VaultFactory, VestingFactory and
/// ProPass (their constructors probe their keys, so the keys come first) and allow-lists the v4 PositionManager.
/// The sender must already own the FeeController. It becomes the VaultFactory's owner.
///
/// Environment:
///   ARCOS_FEE_CONTROLLER       R0's FeeController on this network (required)
///   ARCOS_V4_POSITION_MANAGER  Uniswap v4's PositionManager on this network (required)
///   ARCOS_R1_CONTINUE          "true" finishes an earlier run that stopped part-way (default false). Without it, the
///                              script refuses as soon as one of its keys already exists.
///   ARCOS_VAULT_FACTORY, ARCOS_VESTING_FACTORY, ARCOS_PRO_PASS
///                              with ARCOS_R1_CONTINUE only: contracts that earlier run already deployed. Each is
///                              checked and reused; an unset one is deployed.
/// With ARCOS_R1_CONTINUE=true and everything in place, a run sends no transaction at all.
contract DeployR1 is Script {
    struct Config {
        FeeController fees;
        address v4PositionManager;
        bool continueRun;
        address vaultFactory;
        address vestingFactory;
        address proPass;
    }

    struct FeeKey {
        string name;
        bytes32 key;
        uint256 value;
        uint256 cap;
    }

    function run() external returns (VaultFactory vaults, VestingFactory vestings, ProPass pass) {
        Config memory cfg = Config({
            fees: FeeController(vm.envAddress("ARCOS_FEE_CONTROLLER")),
            v4PositionManager: vm.envAddress("ARCOS_V4_POSITION_MANAGER"),
            continueRun: vm.envOr("ARCOS_R1_CONTINUE", false),
            vaultFactory: vm.envOr("ARCOS_VAULT_FACTORY", address(0)),
            vestingFactory: vm.envOr("ARCOS_VESTING_FACTORY", address(0)),
            proPass: vm.envOr("ARCOS_PRO_PASS", address(0))
        });
        return deploy(cfg);
    }

    /// The five keys. Each equals the constant its contract probes (VaultFactory.LOCK_*, VestingFactory.VEST_FLAT,
    /// ProPass.PRO_MONTHLY; test/DeployR1.t.sol checks it). Flat fees are native USDC at 18 decimals; _BPS keys are
    /// basis points.
    function feeKeys() public pure returns (FeeKey[5] memory) {
        return [
            FeeKey("LOCK_FLAT", keccak256("LOCK_FLAT"), 30 ether, 150 ether),
            FeeKey("LOCK_LP_BPS", keccak256("LOCK_LP_BPS"), 50, 100),
            FeeKey("LOCK_FEE_SHARE_BPS", keccak256("LOCK_FEE_SHARE_BPS"), 200, 500),
            FeeKey("VEST_FLAT", keccak256("VEST_FLAT"), 20 ether, 100 ether),
            FeeKey("PRO_MONTHLY", keccak256("PRO_MONTHLY"), 9 ether, 29 ether)
        ];
    }

    function deploy(Config memory cfg) public returns (VaultFactory vaults, VestingFactory vestings, ProPass pass) {
        FeeController fees = cfg.fees;
        require(address(fees).code.length != 0, "DeployR1: no contract at ARCOS_FEE_CONTROLLER.");
        require(cfg.v4PositionManager.code.length != 0, "DeployR1: no contract at ARCOS_V4_POSITION_MANAGER.");
        require(
            cfg.continueRun
                || (cfg.vaultFactory == address(0) && cfg.vestingFactory == address(0) && cfg.proPass == address(0)),
            "DeployR1: deployed addresses are used only with ARCOS_R1_CONTINUE=true."
        );

        vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        require(
            fees.owner() == sender, "DeployR1: the sender does not own the FeeController. Accept its ownership first."
        );

        // Every check runs before the first transaction, so a refusal leaves the chain as it was.
        FeeKey[5] memory keys = feeKeys();
        bool[5] memory present;
        for (uint256 i; i < keys.length; ++i) {
            present[i] = _checkKey(fees, keys[i], cfg.continueRun);
        }
        if (cfg.vaultFactory != address(0)) {
            _checkWired(
                cfg.vaultFactory,
                fees,
                VaultFactory(cfg.vaultFactory).LOCK_FLAT.selector,
                "LOCK_FLAT",
                "ARCOS_VAULT_FACTORY",
                "VaultFactory"
            );
            require(
                VaultFactory(cfg.vaultFactory).owner() == sender,
                "DeployR1: the sender does not own ARCOS_VAULT_FACTORY."
            );
        }
        if (cfg.vestingFactory != address(0)) {
            _checkWired(
                cfg.vestingFactory,
                fees,
                VestingFactory(cfg.vestingFactory).VEST_FLAT.selector,
                "VEST_FLAT",
                "ARCOS_VESTING_FACTORY",
                "VestingFactory"
            );
        }
        if (cfg.proPass != address(0)) {
            _checkWired(
                cfg.proPass, fees, ProPass(cfg.proPass).PRO_MONTHLY.selector, "PRO_MONTHLY", "ARCOS_PRO_PASS", "ProPass"
            );
        }

        for (uint256 i; i < keys.length; ++i) {
            if (present[i]) {
                console2.log("key already set", keys[i].name);
            } else {
                fees.addKey(keys[i].key, keys[i].value, keys[i].cap);
                console2.log("key added      ", keys[i].name);
            }
        }

        vaults = cfg.vaultFactory != address(0) ? VaultFactory(cfg.vaultFactory) : new VaultFactory(sender, fees);
        vestings = cfg.vestingFactory != address(0) ? VestingFactory(cfg.vestingFactory) : new VestingFactory(fees);
        pass = cfg.proPass != address(0) ? ProPass(cfg.proPass) : new ProPass(fees);

        // Testnet has no Uniswap v3, so the v4 PositionManager is the only manager to allow.
        (bool allowed, PositionVault.Kind kind) = vaults.managers(cfg.v4PositionManager);
        if (allowed && kind == PositionVault.Kind.V4) {
            console2.log("v4 PositionManager already allowed");
        } else {
            vaults.setManager(cfg.v4PositionManager, true, PositionVault.Kind.V4);
            console2.log("v4 PositionManager allowed");
        }
        vm.stopBroadcast();

        console2.log("VaultFactory  ", address(vaults));
        console2.log("VestingFactory", address(vestings));
        console2.log("ProPass       ", address(pass));
        // Position vaults send the platform's share to the recipient with a 100,000-gas budget: 0 here means a plain
        // account, which always fits. See DEPLOY.md, R1 notes.
        console2.log("fee recipient code size", fees.recipient().code.length);
    }

    /// True if the key is already there with this fee and cap and no change pending (allowed only when continuing);
    /// reverts otherwise.
    function _checkKey(FeeController fees, FeeKey memory k, bool continueRun) internal view returns (bool present) {
        try fees.feeOf(k.key) returns (uint256 value) {
            require(
                continueRun,
                string.concat(
                    "DeployR1: fee key ",
                    k.name,
                    " already exists. Set ARCOS_R1_CONTINUE=true to finish an earlier run."
                )
            );
            require(
                value == k.value && fees.capOf(k.key) == k.cap,
                string.concat("DeployR1: fee key ", k.name, " exists with another fee or cap. Check it by hand.")
            );
            (, uint64 pendingAt) = fees.pendingOf(k.key);
            require(
                pendingAt == 0,
                string.concat("DeployR1: fee key ", k.name, " has a pending fee change. Check it by hand.")
            );
            return true;
        } catch (bytes memory reason) {
            // Anything but "no such key" (a wrong address, a node error) must stop the run, not add the key.
            require(
                keccak256(reason) == keccak256(abi.encodeWithSelector(FeeController.UnknownKey.selector, k.key)),
                string.concat("DeployR1: could not read fee key ", k.name, " from ARCOS_FEE_CONTROLLER.")
            );
            return false;
        }
    }

    /// The contract at `target` is the kind `envName` names, told apart by one of its own key constants (`keySelector`,
    /// the getter of the constant that must equal keccak256(`keyName`)), and is wired to `fees`. VaultFactory,
    /// VestingFactory and ProPass all expose `feeController()`.
    function _checkWired(
        address target,
        FeeController fees,
        bytes4 keySelector,
        string memory keyName,
        string memory envName,
        string memory kind
    ) internal view {
        require(target.code.length != 0, string.concat("DeployR1: no contract at ", envName, "."));
        // A low-level call, so a contract without that getter (or with a fallback) is refused, not a stray revert.
        (bool ok, bytes memory ret) = target.staticcall(abi.encodeWithSelector(keySelector));
        require(
            ok && ret.length == 32 && abi.decode(ret, (bytes32)) == keccak256(bytes(keyName)),
            string.concat("DeployR1: ", envName, " is not a ", kind, ".")
        );
        require(
            address(ProPass(target).feeController()) == address(fees),
            string.concat("DeployR1: ", envName, " is wired to another FeeController.")
        );
    }
}
