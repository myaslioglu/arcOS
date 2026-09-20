# Deploying ARC.os contracts

You run these yourself. Your private key never leaves your terminal and is never pasted into a chat, a file or an env var.

All commands below are run from `packages/contracts` inside the `arc-os` repo. Open a terminal there first:

    cd packages/contracts

## Once: store the deployer key in Foundry's encrypted keystore

    npx cast wallet import arcos-deployer --interactive

Paste the key at the hidden prompt, then choose a password. Check the address:

    npx cast wallet address --account arcos-deployer

## Testnet

(still inside `packages/contracts`)

1. Get test USDC for that address: https://faucet.circle.com → Arc Testnet → USDC (20 per request, every 2 hours).
2. Deploy:

       export ARCOS_OWNER=0xYourOwnerAddress          # <- replace with the real owner address; owns FeeController, a multisig is best
       export ARCOS_FEE_RECIPIENT=0xYourFeeAddress    # <- replace with the real fee-recipient address
       npx forge script script/DeployR0.s.sol --rpc-url arc_testnet --account arcos-deployer --broadcast

   The script prints three lines, each `<contract name>  0x<address>` — `FeeController`, `TokenFactory`, `Multisend`. Keep those addresses; you need them below and in Step 5.

3. If `ARCOS_OWNER` isn't the deployer, the owner must accept ownership, from the owner's own terminal and keystore:

       npx cast send <FeeController-address-from-step-2> "acceptOwnership()" --rpc-url arc_testnet --account <owner-keystore-name>

   Replace `<FeeController-address-from-step-2>` with the `FeeController` address printed in step 2, and `<owner-keystore-name>` with whatever name the owner used when they imported their own key with `cast wallet import`.

4. Verify on the explorer (repeat per contract; FeeController takes `constructor(address,address)`):

       npx forge verify-contract <TokenFactory-address-from-step-2> src/TokenFactory.sol:TokenFactory \
         --chain-id 5042002 --verifier blockscout --verifier-url https://explorer.testnet.arc.io/api/ \
         --constructor-args $(npx cast abi-encode "constructor(address)" <FeeController-address-from-step-2>)

   Again, replace `<TokenFactory-address-from-step-2>` and `<FeeController-address-from-step-2>` with the addresses printed in step 2.

5. Tell the agent the three addresses (they're public), or let it read them from
   `broadcast/DeployR0.s.sol/5042002/run-latest.json` (this path is relative to `packages/contracts`, where you're standing).

## Mainnet

Same commands (still from `packages/contracts`) with `--rpc-url arc`, `--chain-id 5042` and `--verifier-url https://explorer.arc.io/api/`.
The mainnet explorer API may refuse command-line clients (it sits behind a bot check). If verification fails,
produce the standard JSON input and upload it in the explorer's "Verify & publish" page in your browser:

    npx forge verify-contract <deployed-contract-address> src/TokenFactory.sol:TokenFactory --show-standard-json-input > TokenFactory.input.json

Replace `<deployed-contract-address>` with the address of the contract you're verifying.

Before mainnet: every test passes, the testnet deployment has been used end to end from the app, and
`ARCOS_OWNER` is a wallet you can't lose.

## What the agent still needs from you

Deployment (steps above) needs your private key, so the agent stops here and waits for you. Once you've deployed to testnet, give the agent one of:

- the three testnet addresses (`FeeController`, `TokenFactory`, `Multisend`) — they're public, safe to paste anywhere, or
- permission to read `broadcast/DeployR0.s.sol/5042002/run-latest.json` itself (inside `packages/contracts`).

Either way, the agent then fills in `ARCOS.testnet` in `packages/chain/src/addresses.ts` and confirms the on-chain checks in the brief — nothing else changes until it has one of these two things from you.
