# Deploying 4rc.OS contracts

You sign every transaction yourself, either with a keystore key in your terminal or in your browser wallet. Your private
key is never pasted into a chat, a file or an env var.

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

## Alternative: sign in a browser wallet (no key export)

The key never leaves the wallet extension. Nothing below needs a private key, a keystore or `--account`.
This is how the testnet deployment of 2026-09-22 was made (Foundry 1.7.1, Trust Wallet extension).

    export ARCOS_OWNER=0xYourAddress ARCOS_FEE_RECIPIENT=0xYourAddress
    npx forge script script/DeployR0.s.sol --rpc-url arc_testnet --broadcast --slow \
      --browser --browser-disable-open --sender $ARCOS_OWNER

Then, in the browser that has the wallet:

1. Open **http://127.0.0.1:9545**, not `localhost:9545`. The page calls `127.0.0.1`; opened from
   `localhost` it is a different origin and every call is blocked by CORS.
2. **Connect Wallet** → **Confirm Connection** → **Sign & Send** → confirm in the wallet.
3. Foundry 1.7.1's page handles **one transaction per page load**. When the Receipt box shows
   `"status": "success"`, reload the page and repeat step 2 for the next transaction (six in all).
4. **Never reload before the receipt shows success.** A reload while Foundry still holds the request
   sends the same transaction again, and a wallet that picks its own nonce (Trust Wallet does) turns
   the copy into a real transaction. Here a second `addKey(DROP_MIN)` reverted with `KeyExists`,
   Foundry stopped with `Transaction Failure`, and the spent nonce moved every later address.

If the script stops part-way, don't `--resume` (its recorded nonces no longer match the chain). Check
which steps landed (`feeOf` for each key, `cast codesize` for each contract) and deploy what's missing
one contract per command. `--constructor-args` must be the **last** flag; it swallows everything after it:

    npx forge create src/TokenFactory.sol:TokenFactory --rpc-url arc_testnet --broadcast \
      --browser --browser-disable-open --constructor-args <FeeController-address>
    npx forge create src/Multisend.sol:Multisend --rpc-url arc_testnet --broadcast \
      --browser --browser-disable-open --constructor-args <FeeController-address>

Take the addresses from each command's `Deployed to:` line, not from `broadcast/…/run-latest.json`,
whose predicted addresses are wrong once a nonce has been spent on something else.

For mainnet, use a wallet made for this (or a multisig) as `ARCOS_OWNER` and `ARCOS_FEE_RECIPIENT`, not a
personal wallet: an EVM address is the same on every chain, and the public repo ties it to its owner.

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
`ARCOS_OWNER` is a wallet you can't lose. The testnet `TokenFactory` predates the current name rule, so that
end-to-end use doesn't exercise it. Cover the rule instead with the forge suite (`test/TokenFactoryNames.t.sol`,
shared vectors in `test/vectors/names.json`), a rehearsal of this deployment on a local fork of mainnet, and
`docs/QA-R0.md` run on mainnet right after the deployment.

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

## Deployments

| Network | Contract | Address |
|---|---|---|
| Arc Testnet (5042002) | FeeController | [`0xC470753e83c151a6A4A360869270291A6ED70d99`](https://explorer.testnet.arc.io/address/0xC470753e83c151a6A4A360869270291A6ED70d99) |
| Arc Testnet (5042002) | TokenFactory | [`0x41FaFc54ED3be1545695B82af4aA490607447884`](https://explorer.testnet.arc.io/address/0x41FaFc54ED3be1545695B82af4aA490607447884) |
| Arc Testnet (5042002) | Multisend | [`0x113f3864C94ff6a14310a789bD671de5b78D6CBf`](https://explorer.testnet.arc.io/address/0x113f3864C94ff6a14310a789bD671de5b78D6CBf) |
| Arc (5042) | FeeController | [`0x2B37F9a9443B2DfaE6B7C7063586935a574B5699`](https://explorer.arc.io/address/0x2B37F9a9443B2DfaE6B7C7063586935a574B5699) |
| Arc (5042) | TokenFactory | [`0xa68edD822048C00dC816d93005B72F8a50234a24`](https://explorer.arc.io/address/0xa68edD822048C00dC816d93005B72F8a50234a24) |
| Arc (5042) | Multisend | [`0x03ddE90Fde3983CEEE600dbc9b76f6D73512af47`](https://explorer.arc.io/address/0x03ddE90Fde3983CEEE600dbc9b76f6D73512af47) |

These are also `ARCOS` in `packages/chain/src/addresses.ts`, which is what the app reads.

The testnet `TokenFactory` predates the current name rule (it checks each byte only for ASCII control characters, so malformed UTF-8 and bidi, line-break and invisible characters still pass there); the
mainnet deployment uses the current source.

## What the agent still needs from you

Every step that signs a transaction is yours: with a keystore key in your terminal, or with the browser-wallet
path above, where the agent can run the command but only you can confirm each transaction in your wallet.
After a deployment, give the agent the three addresses (they're public) so it can fill in `ARCOS.<network>`
and run the checks under "After wiring the addresses".
