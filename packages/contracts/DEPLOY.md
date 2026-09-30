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

One question about a blocklisted recipient in a native drop (`Multisend.sendNative`) is still open. It is the first
entry under "Open questions", at the end of this file.

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

5. Take the three addresses (they're public) from the script's output, or read them from
   `broadcast/DeployR0.s.sol/5042002/run-latest.json` (this path is relative to `packages/contracts`, where you're standing),
   and put them in `ARCOS.testnet` in `packages/chain/src/addresses.ts`.
   Do this only after step 4 has verified the TokenFactory: the Inspector counts every token that factory creates as
   source-verified through it, which is true only once the factory's own source is verified.

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

## R1: Vault, Vesting and ProPass (testnet)

`script/DeployR1.s.sol` adds R1's five fee keys to R0's FeeController, deploys `VaultFactory`, `VestingFactory` and
`ProPass`, and allow-lists Uniswap v4's PositionManager in the VaultFactory. The keys come first: each constructor
reads its keys and reverts if one is missing. Testnet has no Uniswap v3, so v4 is the only manager allowed there.

| Key | Fee | Cap | Read by |
|---|---|---|---|
| `LOCK_FLAT` | 30 USDC (`30e18`) | 150 USDC | VaultFactory, per lock |
| `LOCK_LP_BPS` | 50 bps (0.5%) | 100 bps | VaultFactory, share of a v2 LP token lock |
| `LOCK_FEE_SHARE_BPS` | 200 bps (2%) | 500 bps | VaultFactory, share of a locked position's collected fees |
| `VEST_FLAT` | 20 USDC (`20e18`) | 100 USDC | VestingFactory, per schedule |
| `PRO_MONTHLY` | 9 USDC (`9e18`) | 29 USDC | ProPass, per month |

Flat fees are native USDC at 18 decimals, like R0's. A fee can later go down at once, or up to its cap after
`FeeController.DELAY` (48 hours); a cap never changes.

The addresses the commands below use. Each was read on chain on 2026-09-30 (`cast codesize`, `cast call`):

| What | Address | Checked |
|---|---|---|
| FeeController (R0, testnet) | `0xC470753e83c151a6A4A360869270291A6ED70d99` | 2,209 bytes of code; `DELAY()` = 172800; R0's three keys read back; the TokenFactory's `feeController()` returns it |
| Uniswap v4 PositionManager (testnet) | `0x6049c9a0e26405C0985f9E3685C87d0aE917f82B` | 23,877 bytes of code; `poolManager()` = `0x8366a39CC670B4001A1121B8F6A443A643e40951`; `name()` = "Uniswap v4 Positions NFT". The same address as `test/fork/ArcUniswap.sol` on mainnet |
| Project wallet | `0x463A81a017326E9029DcCA2a2d9AA42599Bef12c` | no code (a plain account) |

The mainnet v3 NonfungiblePositionManager address has no code on testnet.

Today the testnet FeeController is owned by the personal wallet that deployed R0, and its fee recipient is not the
project wallet. Both move to the project wallet first. After that, the project wallet signs everything for R1.

### Owner steps, in order

All commands run from `packages/contracts`, and each block pastes as is into zsh (the macOS default) or bash: no
comments on command lines, and every expected value is in the text or a table next to its block. Each `cast send` and
the deployment can be signed with a keystore key (`--account <name>`) or in the browser wallet
(`--browser --browser-disable-open`, then the steps under "Alternative: sign in a browser wallet" above: open
http://127.0.0.1:9545, one transaction per page load, never reload before the receipt shows success). Replace each
`<...>` placeholder before running its line.

    export ETH_RPC_URL=https://rpc.testnet.arc.io
    export FEES=0xC470753e83c151a6A4A360869270291A6ED70d99
    export PROJECT=0x463A81a017326E9029DcCA2a2d9AA42599Bef12c
    export V4_PM=0x6049c9a0e26405C0985f9E3685C87d0aE917f82B

`cast` reads the testnet RPC from `ETH_RPC_URL`, so the `cast` commands below carry no `--rpc-url`; the `forge`
commands name it (`--rpc-url arc_testnet`, from `foundry.toml`).

1. **Testnet USDC for the project wallet.** https://faucet.circle.com → Arc Testnet → USDC, sent to `$PROJECT`. The
   deployment needs about 0.4 USDC of gas (8.3 million gas at about 48 gwei in the dry run). The T1 check in step 7
   pays `VEST_FLAT` (20 USDC, which comes back, since the project wallet is the fee recipient) plus 1 USDC, so hold at
   least 25 USDC before step 7. The faucet sends 20 USDC per request and one request every 2 hours, so that takes two
   requests, 2 hours apart.

2. **The personal wallet hands over the FeeController, once.** Signed by the personal wallet (the one that owns it
   today):

       npx cast send $FEES "transferOwnership(address)" $PROJECT --account <personal-keystore>

   Check: `npx cast call $FEES "pendingOwner()(address)"` prints `$PROJECT`. The personal wallet stays the owner until
   step 3.

3. **The project wallet accepts ownership.** From here on, everything is signed by the project wallet:

       npx cast send $FEES "acceptOwnership()" --account <project-keystore>

   Check: `npx cast call $FEES "owner()(address)"` prints `$PROJECT` and `npx cast call $FEES "pendingOwner()(address)"`
   prints the zero address.

4. **The project wallet becomes the fee recipient:**

       npx cast send $FEES "setRecipient(address)" $PROJECT --account <project-keystore>

   Check: `npx cast call $FEES "recipient()(address)"` prints `$PROJECT`. (Q20 below: the recipient must stay a plain
   account.)

5. **Dry run, then deploy.** The dry run has no `--broadcast`: it signs nothing and sends nothing.

       export ARCOS_FEE_CONTROLLER=$FEES ARCOS_V4_POSITION_MANAGER=$V4_PM
       npx forge script script/DeployR1.s.sol --rpc-url arc_testnet --sender $PROJECT

   It must print the same `== Logs ==` as below and end with `SIMULATION COMPLETE`. The dry run's plan,
   `broadcast/DeployR1.s.sol/5042002/dry-run/run-latest.json`, holds nine transactions: five `addKey`, three contract
   creations (VaultFactory, VestingFactory, ProPass) and `setManager`. Then deploy, with a keystore key:

       npx forge script script/DeployR1.s.sol --rpc-url arc_testnet --broadcast --slow \
         --account <project-keystore> --sender $PROJECT

   or in the browser wallet (nine page loads, one per transaction):

       npx forge script script/DeployR1.s.sol --rpc-url arc_testnet --broadcast --slow \
         --browser --browser-disable-open --sender $PROJECT

   Expected output (the three addresses are the real ones on the live run):

       == Logs ==
         key added       LOCK_FLAT
         key added       LOCK_LP_BPS
         key added       LOCK_FEE_SHARE_BPS
         key added       VEST_FLAT
         key added       PRO_MONTHLY
         v4 PositionManager allowed
         VaultFactory   0x...
         VestingFactory 0x...
         ProPass        0x...
         fee recipient code size 0

   **A `DeployR1:` message anywhere in the output means the script refused: stop there, whatever the exit code.**
   `npx forge` can exit 0 after a failure (its npm wrapper drops forge's exit status), so the exit code proves nothing.
   The script checks everything before its first transaction, so a refusal leaves the chain as it was. It refuses if:
   - the sender does not own the FeeController (`the sender does not own the FeeController. Accept its ownership
     first.`): steps 2 and 3 are not done, or `--sender` is wrong;
   - one of the five keys already exists (`fee key <NAME> already exists. Set ARCOS_R1_CONTINUE=true to finish an
     earlier run.`);
   - an address has no code, or a key cannot be read.

   **If a run stops part-way** (a browser reload, a nonce taken by the wallet), don't use forge's `--resume`. Look at
   the project wallet's transactions on https://explorer.testnet.arc.io and note which contracts were created (take
   each address from the explorer, not from `broadcast/…/run-latest.json`). Then run the script again, dry run first,
   with:

       export ARCOS_R1_CONTINUE=true

   and, for each contract that was created, its line from these three, with its address:

       export ARCOS_VAULT_FACTORY=<VaultFactory address>
       export ARCOS_VESTING_FACTORY=<VestingFactory address>
       export ARCOS_PRO_PASS=<ProPass address>

   Leave out the line of a contract that was not created; never set a variable to an empty value. In this mode a key
   that exists with the same fee and cap and no pending change is kept (`key already set`); a key with another fee or
   cap, or with a pending change, stops the run. Each address given must be the contract its variable names (checked
   through the contract's own key constant, so swapped addresses are refused), wired to this FeeController, and for the
   VaultFactory owned by the sender. A contract not given is deployed, and `setManager` is sent only if the manager is
   not allowed yet. With everything in place it sends nothing, so the same dry run is also a check that the deployment
   is complete. Once the deployment is complete, clear the variables, so a later run starts fresh:

       unset ARCOS_R1_CONTINUE ARCOS_VAULT_FACTORY ARCOS_VESTING_FACTORY ARCOS_PRO_PASS

6. **Verify the source on the explorer.** Take the three addresses from step 5. VaultFactory's constructor is
   `(owner, feeController)`, where the owner is the sender (`$PROJECT`); the other two take the FeeController only:

       npx forge verify-contract <VaultFactory> src/vault/VaultFactory.sol:VaultFactory \
         --chain-id 5042002 --verifier blockscout --verifier-url https://explorer.testnet.arc.io/api/ \
         --constructor-args $(npx cast abi-encode "constructor(address,address)" $PROJECT $FEES)
       npx forge verify-contract <VestingFactory> src/vesting/VestingFactory.sol:VestingFactory \
         --chain-id 5042002 --verifier blockscout --verifier-url https://explorer.testnet.arc.io/api/ \
         --constructor-args $(npx cast abi-encode "constructor(address)" $FEES)
       npx forge verify-contract <ProPass> src/ProPass.sol:ProPass \
         --chain-id 5042002 --verifier blockscout --verifier-url https://explorer.testnet.arc.io/api/ \
         --constructor-args $(npx cast abi-encode "constructor(address)" $FEES)

   The VaultFactory creates the two vault implementations in its constructor. Read their addresses with
   `npx cast call <VaultFactory> "lockVaultImpl()(address)"` (and `positionVaultImpl()`), and verify each with no
   constructor arguments (`src/vault/LockVault.sol:LockVault`, `src/vault/PositionVault.sol:PositionVault`). Each
   vesting wallet is its own contract (`src/vesting/ArcVesting.sol:ArcVesting`, constructor
   `(beneficiary, start, duration, cliff)`), verified one by one if needed.

7. **Checks after the deployment.** All read-only. First the three addresses from step 5:

       export VAULTS=<VaultFactory> VESTINGS=<VestingFactory> PASS=<ProPass>

   Ownership and recipient:

       npx cast call $FEES "owner()(address)"
       npx cast call $FEES "pendingOwner()(address)"
       npx cast call $FEES "recipient()(address)"
       npx cast codesize $PROJECT
       npx cast call $VAULTS "owner()(address)"
       npx cast call $VAULTS "pendingOwner()(address)"

   | Line | Expected |
   |---|---|
   | FeeController `owner()` | `$PROJECT` |
   | FeeController `pendingOwner()` | `0x0000000000000000000000000000000000000000` |
   | FeeController `recipient()` | `$PROJECT` |
   | `codesize $PROJECT` | `0` (Q20) |
   | VaultFactory `owner()` | `$PROJECT` |
   | VaultFactory `pendingOwner()` | `0x0000000000000000000000000000000000000000` |

   Each key's fee, cap and pending change (value and time), one line per key:

       for K in LOCK_FLAT LOCK_LP_BPS LOCK_FEE_SHARE_BPS VEST_FLAT PRO_MONTHLY; do
         echo $K $(npx cast call $FEES "feeOf(bytes32)(uint256)" $(npx cast keccak $K)) \
           $(npx cast call $FEES "capOf(bytes32)(uint256)" $(npx cast keccak $K)) \
           $(npx cast call $FEES "pendingOf(bytes32)(uint256,uint64)" $(npx cast keccak $K))
       done

   | Key | Fee | Cap | Pending |
   |---|---|---|---|
   | `LOCK_FLAT` | `30000000000000000000 [3e19]` | `150000000000000000000 [1.5e20]` | `0 0` |
   | `LOCK_LP_BPS` | `50` | `100` | `0 0` |
   | `LOCK_FEE_SHARE_BPS` | `200` | `500` | `0 0` |
   | `VEST_FLAT` | `20000000000000000000 [2e19]` | `100000000000000000000 [1e20]` | `0 0` |
   | `PRO_MONTHLY` | `9000000000000000000 [9e18]` | `29000000000000000000 [2.9e19]` | `0 0` |

   Wiring and the manager allow-list:

       npx cast call $VAULTS "feeController()(address)"
       npx cast call $VESTINGS "feeController()(address)"
       npx cast call $PASS "feeController()(address)"
       npx cast call $VAULTS "managers(address)(bool,uint8)" $V4_PM

   The three `feeController()` lines print `$FEES`; `managers` prints `true` and `1` (1 = `Kind.V4`).

   Registries: nothing registered yet, and the factories are not their own entries. Each line prints `false`:

       npx cast call $VAULTS "isVault(address)(bool)" $VAULTS
       npx cast call $VESTINGS "isVesting(address)(bool)" $VESTINGS
       npx cast call $PASS "isPro(address)(bool)" $PROJECT

   Then the no-op rerun, a dry run in continue mode with the three addresses:

       export ARCOS_FEE_CONTROLLER=$FEES ARCOS_V4_POSITION_MANAGER=$V4_PM
       export ARCOS_R1_CONTINUE=true ARCOS_VAULT_FACTORY=$VAULTS ARCOS_VESTING_FACTORY=$VESTINGS ARCOS_PRO_PASS=$PASS
       npx forge script script/DeployR1.s.sol --rpc-url arc_testnet --sender $PROJECT
       unset ARCOS_R1_CONTINUE ARCOS_VAULT_FACTORY ARCOS_VESTING_FACTORY ARCOS_PRO_PASS

   Every key prints `key already set`, the manager `already allowed`, and it plans no transaction.

   **T1: does a USDC transfer reach a contract whose `receive` reverts?** `ArcVesting` refuses native value (its
   `receive` reverts), and on Arc the USDC ERC-20 at `0x3600…0000` is a view of the native balance. If an ERC-20
   transfer of that USDC to such a contract reverts, USDC schedules can't be created. A read-only `eth_call` on
   2026-09-30 suggests it succeeds (`transfer(FeeController, 1)` from the project wallet returned `true`, while sending
   native value to the FeeController, which has no `receive`, reverted), but only a real schedule settles it.
   Test it once with 1 USDC (`1000000`, 6 decimals) over one hour, to the project wallet itself. First the approval:

       export U=0x3600000000000000000000000000000000000000
       npx cast send $U "approve(address,uint256)" $VESTINGS 1000000 --account <project-keystore>

   Then simulate the creation (no signature). A revert here means T1 fails: stop and record it.

       export START=$(date +%s)
       npx cast call $VESTINGS "createVesting(address,address,uint256,uint64,uint64,uint64)(address)" \
         $U $PROJECT 1000000 $START 3600 0 --value 20ether --from $PROJECT

   If the simulation returns an address, create it for real:

       npx cast send $VESTINGS "createVesting(address,address,uint256,uint64,uint64,uint64)" \
         $U $PROJECT 1000000 $START 3600 0 --value 20ether --account <project-keystore>

   Take the wallet's address from the `VestingCreated` event in the receipt (or the simulation's output), then check
   it. `isVesting` prints `true` and the balance `1000000`:

       npx cast call $VESTINGS "isVesting(address)(bool)" <wallet>
       npx cast call $U "balanceOf(address)(uint256)" <wallet>

   After the hour, release it; the wallet's balance then prints `0`:

       npx cast send <wallet> "release(address)" $U --account <project-keystore>
       npx cast call $U "balanceOf(address)(uint256)" <wallet>

   If the creation reverts, USDC can't be vested on Arc: the Vesting app must refuse `0x3600…0000` as a token until
   that is solved. Record the answer under "Open questions" either way.

8. **Wire the addresses.** Once steps 6 and 7 pass, put the three addresses in `ARCOS.testnet` in
   `packages/chain/src/addresses.ts` (`vaultFactory`, `vestingFactory`, `proPass`; mainnet stays null) and in the
   Deployments table below. `checkArcosAddresses` then checks their shape. The ABIs the app uses are already in
   `packages/chain/src/abis/` (`npm run abis` regenerates them; they match this source), and the five keys are in
   `FEE_KEYS` in `@arcos/chain`.

### R1 notes

- **Q20, the fee recipient's gas.** A position vault pays the platform's share of collected fees
  (`LOCK_FEE_SHARE_BPS`) to the fee recipient with a fixed 100,000-gas budget. A recipient that needs more (a Safe
  with guards or modules, most contracts with logic in `receive`) is skipped on every collect (`PlatformShareSkipped`),
  and that share goes to the vault's owner instead, for good. The recipient must stay a plain account (code size 0,
  checked in step 7; the script prints it too) or a plain Safe measured to fit, and `setRecipient` must keep to that.
- The VaultFactory's owner can only allow or disallow position managers. It has no power over existing vaults.
  VestingFactory and ProPass have no owner.
- Mainnet is a separate decision: it would need the v3 NonfungiblePositionManager as a second `setManager` (Kind.V3),
  and `ARCOS.mainnet` keeps the three fields null until then.

## Deployments

| Network | Contract | Address |
|---|---|---|
| Arc Testnet (5042002) | FeeController | [`0xC470753e83c151a6A4A360869270291A6ED70d99`](https://explorer.testnet.arc.io/address/0xC470753e83c151a6A4A360869270291A6ED70d99) |
| Arc Testnet (5042002) | TokenFactory | [`0x41FaFc54ED3be1545695B82af4aA490607447884`](https://explorer.testnet.arc.io/address/0x41FaFc54ED3be1545695B82af4aA490607447884) |
| Arc Testnet (5042002) | Multisend | [`0x113f3864C94ff6a14310a789bD671de5b78D6CBf`](https://explorer.testnet.arc.io/address/0x113f3864C94ff6a14310a789bD671de5b78D6CBf) |
| Arc (5042) | FeeController | [`0x2B37F9a9443B2DfaE6B7C7063586935a574B5699`](https://explorer.arc.io/address/0x2B37F9a9443B2DfaE6B7C7063586935a574B5699) |
| Arc (5042) | TokenFactory | [`0xa68edD822048C00dC816d93005B72F8a50234a24`](https://explorer.arc.io/address/0xa68edD822048C00dC816d93005B72F8a50234a24) |
| Arc (5042) | Multisend | [`0x03ddE90Fde3983CEEE600dbc9b76f6D73512af47`](https://explorer.arc.io/address/0x03ddE90Fde3983CEEE600dbc9b76f6D73512af47) |

These are also `ARCOS` in `packages/chain/src/addresses.ts`, which is what the app reads. R1's VaultFactory,
VestingFactory and ProPass are not deployed yet (see "R1" above); they join this table after step 8 there.

The testnet `TokenFactory` predates the current name rule (it checks each byte only for ASCII control characters, so malformed UTF-8 and bidi, line-break and invisible characters still pass there); the
mainnet deployment uses the current source.

## Open questions

If a native-value *recipient* inside a `Multisend.sendNative` drop (not the fee recipient) is blocklisted on Arc, does
only that row fail (skip and refund, the same as any other failed transfer) or does the whole transaction revert? This
can't be verified locally — a blocklist is an Arc network policy, not something Anvil or a local fork can reproduce.
Test it on testnet against a Circle-documented blocklisted test address, if one is published, before relying on the
per-row failure behavior in the UI. (`docs/QA-R0.md` item 31 is the same check.)

T1, for R1: does an ERC-20 transfer of USDC (`0x3600…0000`) to a contract whose `receive` reverts succeed on Arc?
A fork can't answer it (a fork can't move `0x3600` USDC). R1 step 7 settles it with a 1 USDC schedule after the
deployment.

Every step that signs a transaction is the owner's: with a keystore key in a terminal, or with the browser-wallet path
above, where the owner confirms each transaction in the wallet. After a deployment, the three addresses (they're
public) go into `ARCOS.<network>`, and the checks under "After wiring the addresses" run.
