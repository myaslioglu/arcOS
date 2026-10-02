// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, Vm} from "forge-std/Test.sol";
import {DeployR0} from "../script/DeployR0.s.sol";
import {DeployR1} from "../script/DeployR1.s.sol";
import {FeeController} from "../src/FeeController.sol";
import {ProPass} from "../src/ProPass.sol";
import {VaultFactory} from "../src/vault/VaultFactory.sol";
import {PositionVault} from "../src/vault/PositionVault.sol";
import {VestingFactory} from "../src/vesting/VestingFactory.sol";

/// Runs the actual R1 script against R0's actual deployment, after the owner steps DEPLOY.md lists: the R0 owner (the
/// personal wallet on testnet) hands the FeeController to the wallet that runs R1, which accepts it and sets itself as
/// the fee recipient. The script's broadcaster is Foundry's default sender here, standing in for the project wallet.
contract DeployR1Test is Test {
    // The same values DeployR0Test sets: `vm.setEnv` is process-wide and suites run in parallel, so this suite writes
    // exactly what that one writes and never races it.
    address internal personalWallet = makeAddr("arcosOwner");
    address payable internal r0Recipient = payable(makeAddr("arcosFeeRecipient"));
    address internal v4PositionManager = makeAddr("v4PositionManager");

    FeeController internal fees;
    address internal projectWallet;
    DeployR1 internal deployR1;

    function setUp() public {
        vm.setEnv("ARCOS_OWNER", vm.toString(personalWallet));
        vm.setEnv("ARCOS_FEE_RECIPIENT", vm.toString(r0Recipient));
        (fees,,) = new DeployR0().run();
        vm.prank(personalWallet);
        fees.acceptOwnership(); // R0 as it stands on testnet: the personal wallet owns the FeeController

        projectWallet = _broadcaster();

        // The owner steps before the script: transfer, accept, recipient.
        vm.prank(personalWallet);
        fees.transferOwnership(projectWallet);
        vm.prank(projectWallet);
        fees.acceptOwnership();
        vm.prank(projectWallet);
        fees.setRecipient(payable(projectWallet));

        vm.etch(v4PositionManager, hex"00"); // any code: the script only checks that the address is a contract
        deployR1 = new DeployR1();
    }

    function _broadcaster() internal returns (address sender) {
        vm.startBroadcast();
        (, sender,) = vm.readCallers();
        vm.stopBroadcast();
    }

    function _config() internal view returns (DeployR1.Config memory) {
        return DeployR1.Config({
            fees: fees,
            v4PositionManager: v4PositionManager,
            continueRun: false,
            vaultFactory: address(0),
            vestingFactory: address(0),
            proPass: address(0)
        });
    }

    function _assertKey(bytes32 key, uint256 value, uint256 cap) internal view {
        assertEq(fees.feeOf(key), value, "fee");
        assertEq(fees.capOf(key), cap, "cap");
        (uint256 pending, uint64 at) = fees.pendingOf(key);
        assertEq(pending, 0, "pending value");
        assertEq(at, 0, "pending time");
    }

    function _assertDeployment(VaultFactory vaults, VestingFactory vestings, ProPass pass) internal view {
        // The five keys, at the values and caps the spec sets. Flat fees are native USDC at 18 decimals.
        _assertKey(vaults.LOCK_FLAT(), 30 ether, 150 ether);
        _assertKey(vaults.LOCK_LP_BPS(), 50, 100);
        _assertKey(vaults.LOCK_FEE_SHARE_BPS(), 200, 500);
        _assertKey(vestings.VEST_FLAT(), 20 ether, 100 ether);
        _assertKey(pass.PRO_MONTHLY(), 9 ether, 29 ether);
        // R0's keys are untouched.
        assertEq(fees.feeOf(keccak256("MINT_FLAT")), 15 ether);
        assertEq(fees.feeOf(keccak256("DROP_PER_RECIPIENT")), 0.05 ether);
        assertEq(fees.feeOf(keccak256("DROP_MIN")), 2 ether);

        assertEq(address(vaults.feeController()), address(fees));
        assertEq(address(vestings.feeController()), address(fees));
        assertEq(address(pass.feeController()), address(fees));
        assertEq(vaults.owner(), projectWallet);
        assertEq(vaults.pendingOwner(), address(0));
        assertEq(fees.owner(), projectWallet);
        assertEq(fees.pendingOwner(), address(0));
        assertEq(fees.recipient(), projectWallet);

        (bool allowed, PositionVault.Kind kind) = vaults.managers(v4PositionManager);
        assertTrue(allowed, "v4 PositionManager allowed");
        assertEq(uint8(kind), uint8(PositionVault.Kind.V4), "as a v4 manager");

        // Fresh registries.
        assertFalse(vaults.isVault(address(vaults)));
        assertFalse(vestings.isVesting(address(vestings)));
        assertEq(pass.paidUntil(projectWallet), 0);
    }

    function _countTopic(Vm.Log[] memory logs, bytes32 topic) internal pure returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length != 0 && logs[i].topics[0] == topic) ++n;
        }
    }

    function test_run_addsTheKeysDeploysAndAllowsTheV4Manager() public {
        vm.setEnv("ARCOS_FEE_CONTROLLER", vm.toString(address(fees)));
        vm.setEnv("ARCOS_V4_POSITION_MANAGER", vm.toString(v4PositionManager));
        (VaultFactory vaults, VestingFactory vestings, ProPass pass) = deployR1.run();
        _assertDeployment(vaults, vestings, pass);
    }

    function test_deploy_isUsableEndToEnd() public {
        (, VestingFactory vestings, ProPass pass) = deployR1.deploy(_config());
        address buyer = makeAddr("buyer");
        vm.deal(buyer, 9 ether);
        uint256 recipientBefore = projectWallet.balance;
        vm.prank(buyer);
        pass.subscribe{value: 9 ether}(buyer, 1);
        assertTrue(pass.isPro(buyer));
        assertEq(projectWallet.balance - recipientBefore, 9 ether, "the fee reached the recipient");
        assertEq(vestings.vestingsForTokenLength(address(0x3600000000000000000000000000000000000000)), 0);
    }

    function test_rerun_refusesWhenAKeyAlreadyExists() public {
        deployR1.deploy(_config());
        vm.expectRevert(
            bytes("DeployR1: fee key LOCK_FLAT already exists. Set ARCOS_R1_CONTINUE=true to finish an earlier run.")
        );
        deployR1.deploy(_config());
    }

    function test_run_refusesAKeyAddedByHandWithoutContinue() public {
        vm.prank(projectWallet);
        fees.addKey(keccak256("PRO_MONTHLY"), 9 ether, 29 ether);
        vm.expectRevert(
            bytes("DeployR1: fee key PRO_MONTHLY already exists. Set ARCOS_R1_CONTINUE=true to finish an earlier run.")
        );
        deployR1.deploy(_config());
    }

    function test_continue_refusesAKeyWithAnotherFeeOrCap() public {
        vm.prank(projectWallet);
        fees.addKey(keccak256("VEST_FLAT"), 20 ether, 99 ether);
        DeployR1.Config memory cfg = _config();
        cfg.continueRun = true;
        vm.expectRevert(bytes("DeployR1: fee key VEST_FLAT exists with another fee or cap. Check it by hand."));
        deployR1.deploy(cfg);
    }

    function test_continue_withEverythingInPlace_isANoOp() public {
        (VaultFactory vaults, VestingFactory vestings, ProPass pass) = deployR1.deploy(_config());
        DeployR1.Config memory cfg = _config();
        cfg.continueRun = true;
        cfg.vaultFactory = address(vaults);
        cfg.vestingFactory = address(vestings);
        cfg.proPass = address(pass);
        uint64 nonceBefore = vm.getNonce(projectWallet);

        vm.recordLogs();
        (VaultFactory vaults2, VestingFactory vestings2, ProPass pass2) = deployR1.deploy(cfg);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 0, "no event at all: nothing was added, deployed or set");
        assertEq(vm.getNonce(projectWallet), nonceBefore, "no transaction");
        assertEq(address(vaults2), address(vaults));
        assertEq(address(vestings2), address(vestings));
        assertEq(address(pass2), address(pass));
        _assertDeployment(vaults, vestings, pass);
    }

    function test_continue_finishesARunThatStoppedPartWay() public {
        // An earlier run landed two keys and the VaultFactory's key probe would still fail: it stopped after them.
        vm.startPrank(projectWallet);
        fees.addKey(keccak256("LOCK_FLAT"), 30 ether, 150 ether);
        fees.addKey(keccak256("LOCK_LP_BPS"), 50, 100);
        vm.stopPrank();
        DeployR1.Config memory cfg = _config();
        cfg.continueRun = true;

        vm.recordLogs();
        (VaultFactory vaults, VestingFactory vestings, ProPass pass) = deployR1.deploy(cfg);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(_countTopic(logs, FeeController.KeyAdded.selector), 3, "only the three missing keys");
        assertEq(_countTopic(logs, VaultFactory.ManagerSet.selector), 1);
        _assertDeployment(vaults, vestings, pass);
    }

    function test_continue_reusesADeployedFactoryAndSetsTheManagerOnce() public {
        (VaultFactory vaults,,) = deployR1.deploy(_config());
        DeployR1.Config memory cfg = _config();
        cfg.continueRun = true;
        cfg.vaultFactory = address(vaults);
        // The earlier run stopped after the VaultFactory, before the others and the manager.
        vm.prank(projectWallet);
        vaults.setManager(v4PositionManager, false, PositionVault.Kind.V3);

        vm.recordLogs();
        (VaultFactory vaults2, VestingFactory vestings, ProPass pass) = deployR1.deploy(cfg);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(address(vaults2), address(vaults), "reused");
        assertEq(_countTopic(logs, FeeController.KeyAdded.selector), 0);
        assertEq(_countTopic(logs, VaultFactory.ManagerSet.selector), 1);
        _assertDeployment(vaults, vestings, pass);
    }

    function test_refusesWhenTheSenderDoesNotOwnTheFeeController() public {
        vm.prank(projectWallet);
        fees.transferOwnership(personalWallet);
        vm.prank(personalWallet);
        fees.acceptOwnership();
        vm.expectRevert(bytes("DeployR1: the sender does not own the FeeController. Accept its ownership first."));
        deployR1.deploy(_config());
    }

    function test_refusesWhileOwnershipIsOnlyPending() public {
        // The personal wallet signed transferOwnership, but the project wallet has not accepted yet.
        vm.prank(projectWallet);
        fees.transferOwnership(personalWallet);
        vm.prank(personalWallet);
        fees.acceptOwnership();
        vm.prank(personalWallet);
        fees.transferOwnership(projectWallet);
        vm.expectRevert(bytes("DeployR1: the sender does not own the FeeController. Accept its ownership first."));
        deployR1.deploy(_config());
    }

    function test_refusesAnAddressWithoutCode() public {
        DeployR1.Config memory cfg = _config();
        cfg.v4PositionManager = makeAddr("nothingHere");
        vm.expectRevert(bytes("DeployR1: no contract at ARCOS_V4_POSITION_MANAGER."));
        deployR1.deploy(cfg);

        cfg = _config();
        cfg.fees = FeeController(makeAddr("noController"));
        vm.expectRevert(bytes("DeployR1: no contract at ARCOS_FEE_CONTROLLER."));
        deployR1.deploy(cfg);
    }

    function test_refusesAnyOtherFailureToReadAKey() public {
        // Only "no such key" means "add it": any other failure stops the run before a transaction.
        vm.mockCallRevert(
            address(fees), abi.encodeCall(FeeController.feeOf, (keccak256("VEST_FLAT"))), bytes("node error")
        );
        vm.expectRevert(bytes("DeployR1: could not read fee key VEST_FLAT from ARCOS_FEE_CONTROLLER."));
        deployR1.deploy(_config());
    }

    function test_refusesAddressesWithoutContinue() public {
        (VaultFactory vaults,,) = deployR1.deploy(_config());
        DeployR1.Config memory cfg = _config();
        cfg.vaultFactory = address(vaults);
        vm.expectRevert(bytes("DeployR1: deployed addresses are used only with ARCOS_R1_CONTINUE=true."));
        deployR1.deploy(cfg);
    }

    function test_continue_refusesAFactoryOnAnotherFeeController() public {
        deployR1.deploy(_config());
        FeeController other = new FeeController(projectWallet, payable(projectWallet));
        vm.startPrank(projectWallet);
        other.addKey(keccak256("VEST_FLAT"), 1, 1);
        vm.stopPrank();
        VestingFactory foreign = new VestingFactory(other);

        DeployR1.Config memory cfg = _config();
        cfg.continueRun = true;
        cfg.vestingFactory = address(foreign);
        vm.expectRevert(bytes("DeployR1: ARCOS_VESTING_FACTORY is wired to another FeeController."));
        deployR1.deploy(cfg);
    }

    // Continue mode: each address given must be the contract its variable names, wired to this FeeController, and
    // each key present must match the spec exactly, with nothing pending.

    function _continueConfig() internal view returns (DeployR1.Config memory cfg) {
        cfg = _config();
        cfg.continueRun = true;
    }

    function test_continue_refusesAKeyWithTheRightCapButAnotherFee() public {
        vm.prank(projectWallet);
        fees.addKey(keccak256("VEST_FLAT"), 19 ether, 100 ether);
        vm.expectRevert(bytes("DeployR1: fee key VEST_FLAT exists with another fee or cap. Check it by hand."));
        deployR1.deploy(_continueConfig());
    }

    function test_continue_refusesAKeyWithAPendingFeeChange() public {
        vm.startPrank(projectWallet);
        fees.addKey(keccak256("PRO_MONTHLY"), 9 ether, 29 ether);
        fees.setFee(keccak256("PRO_MONTHLY"), 29 ether); // an increase: scheduled, not applied
        vm.stopPrank();
        assertEq(fees.feeOf(keccak256("PRO_MONTHLY")), 9 ether, "the fee itself still matches");
        vm.expectRevert(bytes("DeployR1: fee key PRO_MONTHLY has a pending fee change. Check it by hand."));
        deployR1.deploy(_continueConfig());
    }

    function test_continue_refusesAVaultFactoryOwnedBySomeoneElse() public {
        deployR1.deploy(_config());
        VaultFactory foreign = new VaultFactory(makeAddr("someoneElse"), fees);
        DeployR1.Config memory cfg = _continueConfig();
        cfg.vaultFactory = address(foreign);
        vm.expectRevert(bytes("DeployR1: the sender does not own ARCOS_VAULT_FACTORY."));
        deployR1.deploy(cfg);
    }

    function _otherFeeController() internal returns (FeeController other) {
        other = new FeeController(projectWallet, payable(projectWallet));
        vm.startPrank(projectWallet);
        other.addKey(keccak256("LOCK_FLAT"), 1, 1);
        other.addKey(keccak256("LOCK_LP_BPS"), 1, 1);
        other.addKey(keccak256("LOCK_FEE_SHARE_BPS"), 1, 1);
        other.addKey(keccak256("PRO_MONTHLY"), 1, 1);
        vm.stopPrank();
    }

    function test_continue_refusesAVaultFactoryOnAnotherFeeController() public {
        deployR1.deploy(_config());
        VaultFactory foreign = new VaultFactory(projectWallet, _otherFeeController());
        DeployR1.Config memory cfg = _continueConfig();
        cfg.vaultFactory = address(foreign);
        vm.expectRevert(bytes("DeployR1: ARCOS_VAULT_FACTORY is wired to another FeeController."));
        deployR1.deploy(cfg);
    }

    function test_continue_refusesAProPassOnAnotherFeeController() public {
        deployR1.deploy(_config());
        ProPass foreign = new ProPass(_otherFeeController());
        DeployR1.Config memory cfg = _continueConfig();
        cfg.proPass = address(foreign);
        vm.expectRevert(bytes("DeployR1: ARCOS_PRO_PASS is wired to another FeeController."));
        deployR1.deploy(cfg);
    }

    // A failed deploy leaves its broadcast open, so each case runs in its own test.
    function _assertRefused(string memory envName, uint8 given, string memory expected) internal {
        (VaultFactory vaults, VestingFactory vestings, ProPass pass) = deployR1.deploy(_config());
        address[4] memory candidates = [address(vaults), address(vestings), address(pass), address(fees)];
        DeployR1.Config memory cfg = _continueConfig();
        if (keccak256(bytes(envName)) == keccak256("ARCOS_VAULT_FACTORY")) cfg.vaultFactory = candidates[given];
        else if (keccak256(bytes(envName)) == keccak256("ARCOS_VESTING_FACTORY")) cfg.vestingFactory = candidates[given];
        else cfg.proPass = candidates[given];
        vm.expectRevert(bytes(expected));
        deployR1.deploy(cfg);
    }

    function test_continue_refusesAVestingFactoryAsTheVaultFactory() public {
        _assertRefused("ARCOS_VAULT_FACTORY", 1, "DeployR1: ARCOS_VAULT_FACTORY is not a VaultFactory.");
    }

    function test_continue_refusesAProPassAsTheVaultFactory() public {
        _assertRefused("ARCOS_VAULT_FACTORY", 2, "DeployR1: ARCOS_VAULT_FACTORY is not a VaultFactory.");
    }

    function test_continue_refusesAVaultFactoryAsTheVestingFactory() public {
        _assertRefused("ARCOS_VESTING_FACTORY", 0, "DeployR1: ARCOS_VESTING_FACTORY is not a VestingFactory.");
    }

    function test_continue_refusesAProPassAsTheVestingFactory() public {
        _assertRefused("ARCOS_VESTING_FACTORY", 2, "DeployR1: ARCOS_VESTING_FACTORY is not a VestingFactory.");
    }

    function test_continue_refusesAVaultFactoryAsTheProPass() public {
        _assertRefused("ARCOS_PRO_PASS", 0, "DeployR1: ARCOS_PRO_PASS is not a ProPass.");
    }

    function test_continue_refusesAVestingFactoryAsTheProPass() public {
        _assertRefused("ARCOS_PRO_PASS", 1, "DeployR1: ARCOS_PRO_PASS is not a ProPass.");
    }

    function test_continue_refusesTheFeeControllerAsTheProPass() public {
        _assertRefused("ARCOS_PRO_PASS", 3, "DeployR1: ARCOS_PRO_PASS is not a ProPass.");
    }
}
