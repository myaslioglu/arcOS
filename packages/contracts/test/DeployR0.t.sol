// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {DeployR0} from "../script/DeployR0.s.sol";
import {FeeController} from "../src/FeeController.sol";
import {TokenFactory} from "../src/TokenFactory.sol";
import {Multisend} from "../src/Multisend.sol";

/// Exercises the actual deploy script (not a re-implementation of it), so a break in DeployR0.s.sol itself
/// — wrong key order, wrong values, wiring a contract to the wrong FeeController, forgetting the ownership
/// handoff — fails the suite instead of only showing up on a live deploy.
contract DeployR0Test is Test {
    address internal ownerAddr = makeAddr("arcosOwner");
    address payable internal recipientAddr = payable(makeAddr("arcosFeeRecipient"));

    function setUp() public {
        vm.setEnv("ARCOS_OWNER", vm.toString(ownerAddr));
        vm.setEnv("ARCOS_FEE_RECIPIENT", vm.toString(recipientAddr));
    }

    function test_run_deploysAndWiresTheDocumentedFees() public {
        DeployR0 deployScript = new DeployR0();
        (FeeController fees, TokenFactory factory, Multisend multisend) = deployScript.run();

        // Mint: 15 / 50 USDC
        assertEq(fees.feeOf(keccak256("MINT_FLAT")), 15 ether);
        assertEq(fees.capOf(keccak256("MINT_FLAT")), 50 ether);
        // Drop, per recipient: 0.05 / 0.5 USDC
        assertEq(fees.feeOf(keccak256("DROP_PER_RECIPIENT")), 0.05 ether);
        assertEq(fees.capOf(keccak256("DROP_PER_RECIPIENT")), 0.5 ether);
        // Drop, minimum: 2 / 10 USDC
        assertEq(fees.feeOf(keccak256("DROP_MIN")), 2 ether);
        assertEq(fees.capOf(keccak256("DROP_MIN")), 10 ether);

        assertEq(address(factory.feeController()), address(fees));
        assertEq(address(multisend.feeController()), address(fees));

        assertEq(fees.recipient(), recipientAddr);

        // The deployer (Foundry's default sender under `vm.startBroadcast()`) is never ARCOS_OWNER here
        // (a fresh makeAddr'd address), so the script must have started the two-step ownership handoff:
        // the deployer stays owner until ARCOS_OWNER calls acceptOwnership() themselves.
        assertEq(fees.pendingOwner(), ownerAddr);
        assertTrue(fees.owner() != ownerAddr);
    }
}
