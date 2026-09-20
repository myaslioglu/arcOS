// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {FeeController} from "../src/FeeController.sol";
import {TokenFactory} from "../src/TokenFactory.sol";
import {Multisend} from "../src/Multisend.sol";

/// Usage: see DEPLOY.md. Reads ARCOS_OWNER and ARCOS_FEE_RECIPIENT from the environment.
contract DeployR0 is Script {
    function run() external returns (FeeController fees, TokenFactory factory, Multisend multisend) {
        address finalOwner = vm.envAddress("ARCOS_OWNER");
        address payable recipient = payable(vm.envAddress("ARCOS_FEE_RECIPIENT"));

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();

        // The deployer owns the controller just long enough to add the keys.
        fees = new FeeController(deployer, recipient);
        fees.addKey(keccak256("MINT_FLAT"), 15 ether, 50 ether);
        fees.addKey(keccak256("DROP_PER_RECIPIENT"), 0.05 ether, 0.5 ether);
        fees.addKey(keccak256("DROP_MIN"), 2 ether, 10 ether);

        factory = new TokenFactory(fees);
        multisend = new Multisend(fees);

        if (finalOwner != deployer) fees.transferOwnership(finalOwner); // finalOwner must call acceptOwnership()
        vm.stopBroadcast();

        console2.log("FeeController", address(fees));
        console2.log("TokenFactory ", address(factory));
        console2.log("Multisend    ", address(multisend));
    }
}
