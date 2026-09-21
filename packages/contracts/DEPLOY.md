# Deploying ARC.os contracts

You run these yourself. Your private key never leaves your terminal and is never pasted into a chat, a file or an env var.

All commands below are run from `packages/contracts` inside the `arc-os` repo. Open a terminal there first:

    cd packages/contracts

## Before you deploy

`ARCOS_FEE_RECIPIENT` must be a plain payable address — an EOA, or a multisig whose `receive()`/fallback
can't revert. Every paid action in these contracts (`TokenFactory.createToken`, `Multisend.sendNative`,
`Multisend.sendToken`) forwards the fee to this address in the same call and reverts the whole transaction
if that transfer fails (`FeeTransferFailed`). A recipient that can't receive value — a contract with no
`receive()`, one that reverts on receipt, or (on Arc) one that's been blocklisted — makes every paid action
revert until the owner calls `FeeController.setRecipient` with a working address. There is no other way to
recover; `FeeController`, `TokenFactory` and `Multisend` are all non-upgradeable.

Ownership of `FeeController` can be transferred but not renounced. `setRecipient` is that recovery lever, so
`renounceOwnership()` always reverts; use `transferOwnership`/`acceptOwnership` instead if `ARCOS_OWNER` ever
needs to change.

`Multisend`'s fee prices the ATTEMPT, not the outcome: `quote(recipients)` is charged per row submitted in
the batch, including rows that go on to fail (and get refunded, for native; left with the sender, for
ERC-20) — it is not reduced or refunded for failed rows.

**Known open question:** if a native-value *recipient* inside a `Multisend.sendNative` drop (not the fee
recipient) is blocklisted on Arc, does only that row fail (skip and refund, the same as any other failed
transfer) or does the whole transaction revert? This can't be verified locally — a blocklist is an Arc
network policy, not something Anvil or a local fork can reproduce. Test it on testnet against a
Circle-documented blocklisted test address, if one is published, before relying on the per-row failure
behavior in the UI.

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

4. Verify on the explorer — repeat per contract. Replace every `<X-address-from-step-2>` placeholder
   with the matching address printed in step 2, and `<deployer-address>` with the address printed by
   `npx cast wallet address --account arcos-deployer` above.

   **`FeeController`'s first constructor argument is the deployer, not `ARCOS_OWNER`.** The script
   deploys it owned by the deployer (`new FeeController(deployer, recipient)`, see
   `script/DeployR0.s.sol`) and only transfers ownership to `ARCOS_OWNER` afterward, in a separate
   `transferOwnership` call — the constructor argument that has to match the deployed bytecode is
   whichever address actually broadcast the deployment, not the final owner. Use
   `<deployer-address>` here even when `ARCOS_OWNER` is a different address:

       npx forge verify-contract <FeeController-address-from-step-2> src/FeeController.sol:FeeController \
         --chain-id 5042002 --verifier blockscout --verifier-url https://explorer.testnet.arc.io/api/ \
         --constructor-args $(npx cast abi-encode "constructor(address,address)" <deployer-address> $ARCOS_FEE_RECIPIENT)

   `TokenFactory` and `Multisend` each take one constructor argument — the `FeeController` address:

       npx forge verify-contract <TokenFactory-address-from-step-2> src/TokenFactory.sol:TokenFactory \
         --chain-id 5042002 --verifier blockscout --verifier-url https://explorer.testnet.arc.io/api/ \
         --constructor-args $(npx cast abi-encode "constructor(address)" <FeeController-address-from-step-2>)

       npx forge verify-contract <Multisend-address-from-step-2> src/Multisend.sol:Multisend \
         --chain-id 5042002 --verifier blockscout --verifier-url https://explorer.testnet.arc.io/api/ \
         --constructor-args $(npx cast abi-encode "constructor(address)" <FeeController-address-from-step-2>)

5. Tell the agent the three addresses (they're public), or let it read them from
   `broadcast/DeployR0.s.sol/5042002/run-latest.json` (this path is relative to `packages/contracts`, where you're standing).

## Mainnet

Same commands (still from `packages/contracts`) with `--rpc-url arc`, `--chain-id 5042` and
`--verifier-url https://explorer.arc.io/api/` — the same three `forge verify-contract` commands from
step 4 above, once each for `FeeController` (`constructor(address,address)`: the deployer's address,
then `ARCOS_FEE_RECIPIENT` — the deployer-not-`ARCOS_OWNER` note in step 4 applies here too),
`TokenFactory` and `Multisend` (`constructor(address)`: the `FeeController` address).

The mainnet explorer API may refuse command-line clients (it sits behind a bot check). If verification
fails, produce the standard JSON input for that contract and upload it in the explorer's
"Verify & publish" page in your browser instead — repeat for each of the three contracts:

    npx forge verify-contract <FeeController-address> src/FeeController.sol:FeeController --show-standard-json-input > FeeController.input.json
    npx forge verify-contract <TokenFactory-address> src/TokenFactory.sol:TokenFactory --show-standard-json-input > TokenFactory.input.json
    npx forge verify-contract <Multisend-address> src/Multisend.sol:Multisend --show-standard-json-input > Multisend.input.json

Replace each `<...-address>` with the address of the contract you're verifying.

The explorer's "Verify & publish" form also has a field for the ABI-encoded constructor arguments —
it does not derive them from the standard-JSON input above, so paste the matching `cast abi-encode`
output into that field for each contract:

    npx cast abi-encode "constructor(address,address)" <deployer-address> $ARCOS_FEE_RECIPIENT   # FeeController
    npx cast abi-encode "constructor(address)" <FeeController-address>                           # TokenFactory
    npx cast abi-encode "constructor(address)" <FeeController-address>                           # Multisend

Each command prints one `0x`-prefixed hex string. Some Blockscout forms want it WITH the leading `0x`
(paste as printed); others want it bare — if the form's field is labeled "hex-encoded" without
mentioning `0x`, or it rejects the value as printed, strip the leading `0x` and paste the rest.

Before mainnet: every test passes, the testnet deployment has been used end to end from the app, and
`ARCOS_OWNER` is a wallet you can't lose.

## After wiring the addresses

Once `ARCOS.<network>` in `packages/chain/src/addresses.ts` has the three real addresses, sanity-check
that they're actually wired together — read-only, no private key needed:

    npx cast call <TokenFactory-address> "feeController()(address)" --rpc-url arc_testnet
    npx cast call <Multisend-address> "feeController()(address)" --rpc-url arc_testnet

Both must print the same address, and it must equal the `feeController` address you put in
`ARCOS.<network>`. (Swap `arc_testnet` for `arc`, and the testnet addresses for the mainnet ones,
when checking a mainnet deployment.)

This is the on-chain half of the address sanity check. The off-chain half — that the three addresses
are each well-formed, checksummed, non-zero and pairwise distinct — is `checkArcosAddresses` in
`packages/chain/src/addressSanity.ts` (pure, unit-tested, no RPC call, no network needed).

## What the agent still needs from you

Deployment (steps above) needs your private key, so the agent stops here and waits for you. Once you've deployed to testnet, give the agent one of:

- the three testnet addresses (`FeeController`, `TokenFactory`, `Multisend`) — they're public, safe to paste anywhere, or
- permission to read `broadcast/DeployR0.s.sol/5042002/run-latest.json` itself (inside `packages/contracts`).

Either way, the agent then fills in `ARCOS.testnet` in `packages/chain/src/addresses.ts` and confirms the on-chain checks in the brief — nothing else changes until it has one of these two things from you.
