# Slither: 4rc.OS R1 contracts

**Result: 46 findings on the in-scope code, none a defect.** 34 are in the contracts and 12 in the deployment
script. Each one is triaged below: none needed a fix, and each is justified with a reason and a code reference.
Nothing in the contract sources was changed for this report.

## Run

| | |
|---|---|
| Slither | 0.11.6 (`slither-analyzer` from PyPI; crytic-compile 0.4.2, solc-select 1.2.0), in a throwaway virtualenv |
| Compiler | solc 0.8.30, `--optimize --optimize-runs 200 --evm-version cancun` (the settings in `foundry.toml`) |
| Source | the contracts after the owner's decisions of 2026-10-02, branch `audit-decisions` at `134d01f` (see `SCOPE.md`). The first run was on the draft's base commit, `main` at `5ad18ee` |
| Detectors | all 102 that ship with 0.11.6; none excluded |
| Date | 2026-10-02 (first run 2026-09-30) |

From `packages/contracts`, with `forge` on `PATH` (crytic-compile reads `forge config` even in solc mode; the npm
install puts it at `node_modules/@foundry-rs/forge-linux-amd64/bin/forge` on Linux):

```sh
python3 -m venv /tmp/slither-venv
/tmp/slither-venv/bin/pip install slither-analyzer==0.11.6
/tmp/slither-venv/bin/slither script/DeployR1.s.sol \
  --compile-force-framework solc \
  --solc "$HOME/.svm/0.8.30/solc-0.8.30" \
  --solc-remaps "@openzeppelin/contracts/=../../node_modules/@openzeppelin/contracts/ forge-std/=../../node_modules/forge-std/src/" \
  --solc-args "--optimize --optimize-runs 200 --evm-version cancun --allow-paths ../../node_modules" \
  --filter-paths "node_modules/"
```

Why this target: `script/DeployR1.s.sol` imports every in-scope contract, so one solc compilation covers the whole
scope. That covers `FeeController`, `ProPass`, `VaultFactory` (and through it `LockVault`, `PositionVault` and the
manager interfaces), and `VestingFactory` (and through it `ArcVesting`). `--filter-paths` drops findings inside
OpenZeppelin and forge-std.

**Why not the foundry route.** `slither .` builds with `forge build --build-info`, skipping `test/` and `script/`. On
this repository it printed 49 "Failed to resolved name for reference id" warnings, and it silently lost findings the
solc run reports:
- in `VaultFactory`: both `uninitialized-local`, the three constructor `unused-return`, both `reentrancy-benign`, and
  two `low-level-calls`;
- in `FeeController`: the `timestamp` finding.

It also reported a false `unimplemented-functions` for `FeeController`, which does implement `IFeeController`: `feeOf`
is a function and `recipient` a public state variable. The warnings come from AST ids the analysis couldn't resolve.
For the in-scope files, its other findings were a subset of the solc run's, so the solc run is the one triaged here.
`--foundry-compile-all`, which adds the tests, showed the same warnings.

The foundry route also reported 20 findings in R0's `Multisend` and `TokenFactory`, which are out of scope
(`SCOPE.md`) and are not triaged here.

## Counts

| Detector | Impact | Confidence | Contracts | Script | Triage |
|---|---|---|---:|---:|---|
| `arbitrary-send-eth` | High | Medium | 2 | 0 | justified |
| `incorrect-equality` | Medium | High | 1 | 0 | justified |
| `uninitialized-local` | Medium | Medium | 2 | 1 | justified |
| `unused-return` | Medium | Medium | 11 | 2 | justified |
| `missing-zero-check` | Low | Medium | 2 | 0 | justified |
| `calls-loop` | Low | Medium | 0 | 8 | justified |
| `reentrancy-benign` | Low | Medium | 2 | 0 | justified |
| `timestamp` | Low | Medium | 8 | 0 | justified |
| `assembly` | Informational | High | 1 | 0 | justified |
| `low-level-calls` | Informational | High | 5 | 1 | justified |
| **Total** | | | **34** | **12** | 0 fixed, 46 justified, 0 open |

No finding from the reentrancy detectors that move value (`reentrancy-eth`, `reentrancy-no-eth`), and none from
`arbitrary-send-erc20`, `controlled-delegatecall`, `unprotected-upgrade`, `suicidal` or `uninitialized-state`.

### Changes since the first run

The 2026-10-02 contract changes (THREAT-MODEL Q21, Q7 and V2) added one finding and moved line numbers in
`VaultFactory.sol` and `ArcVesting.sol`; the other 45 findings are the same ones, with the lines below updated:
- new: `unused-return` in `VaultFactory._requireNoHooks`, which reads only the PoolKey of `getPoolAndPositionInfo`;
- the two `renounceOwnership` overrides (`view`, always reverting) and the `HookedPool` check raised nothing else.

## Triage

Line numbers are the file's own, as Slither printed them.

### `arbitrary-send-eth` (2)

| Finding | Triage |
|---|---|
| `ProPass.subscribe` sends value to `feeController.recipient()` (`src/ProPass.sol` line 57) | **Justified.** The destination is not the caller's choice: it is the recipient the FeeController owner set, which can't be zero (`FeeController.setRecipient`). The amount is exactly `msg.value`, which must equal `months * feeOf(PRO_MONTHLY)` (line 45), so the contract forwards what it was just paid and holds nothing. |
| `VestingFactory.createVesting` sends value to `feeController.recipient()` (`src/vesting/VestingFactory.sol` line 102) | **Justified.** The same pattern: exactly the `VEST_FLAT` fee checked at line 78, to the owner-set recipient, at the end of a `nonReentrant` call. `VaultFactory._takeFlatFee` does the same and is not flagged. |

### `incorrect-equality` (1)

| Finding | Triage |
|---|---|
| `PositionVault._split`: `amount == 0` (`src/vault/PositionVault.sol` line 202) | **Justified.** An early return when the vault holds none of a currency, so nothing is paid and no event is emitted. It never guards a security decision. A donation can only make the balance non-zero, and then the amount is split like any fee, as documented at lines 121-122. |

### `uninitialized-local` (3)

| Finding | Triage |
|---|---|
| `VaultFactory._requirePrincipal`: `owed0`, `owed1` (`src/vault/VaultFactory.sol` lines 255-256) | **Justified, intended.** They are set from `positions()` for a v3 position (line 258). A v4 position has no `tokensOwed`, so for `Kind.V4` they stay zero on purpose and the `OwedNotCollected` check (line 263) passes. Tested both ways in `test/vault/PositionFactory.t.sol`. |
| `DeployR1.deploy`: `present` (`script/DeployR1.s.sol` line 84) | **Justified.** A `bool[5] memory` is zero-initialised, and the first loop (line 86) assigns every element before it is read. |

### `unused-return` (12)

| Finding | Triage |
|---|---|
| `VaultFactory` constructor ignores `feeOf(LOCK_FLAT)`, `feeOf(LOCK_LP_BPS)`, `feeOf(LOCK_FEE_SHARE_BPS)` (`src/vault/VaultFactory.sol` lines 73-75) | **Justified, intended.** These calls are probes: `feeOf` reverts `UnknownKey` for a missing key, and a factory built before its keys exist would be dead for good, since the controller is immutable. The value is read again on every call. Tested by `test_constructor_probesEachFeeKey_revertsWhenMissing`. |
| `VestingFactory` constructor ignores `feeOf(VEST_FLAT)` (`src/vesting/VestingFactory.sol` line 56) | **Justified.** The same probe (`test_constructor_probesTheFeeKey_revertsWhenMissing` in `test/vesting/VestingFactory.t.sol`). |
| `ProPass` constructor ignores `feeOf(PRO_MONTHLY)` (`src/ProPass.sol` line 31) | **Justified.** The same probe (`test_constructor_probesTheFeeKey_revertsWhenMissing` in `test/ProPass.t.sol`). |
| `PositionVault.currencies` reads only `token0`, `token1` of v3 `positions()` (`src/vault/PositionVault.sol` line 107) | **Justified.** Destructuring that keeps the two fields needed. |
| `PositionVault.currencies` ignores `info` from v4 `getPoolAndPositionInfo` (line 109) | **Justified.** Only the `PoolKey`'s currencies are needed; `info` packs the tick range and subscriber flag. |
| `PositionVault.liquidity` reads only `liquidity` of v3 `positions()` (line 117) | **Justified.** Destructuring. |
| `PositionVault._collectV3` ignores `collect`'s `(amount0, amount1)` (lines 180-185) | **Justified, intended.** `_split` then splits the vault's whole balance of each currency (lines 127-128, 201). That also covers value that reached the vault another way, which the vault cannot tell from a fee (lines 121-122). Using the returned amounts would leave such value stuck. |
| `VaultFactory._requirePrincipal` reads `liquidity`, `tokensOwed0`, `tokensOwed1` of v3 `positions()` (line 258) | **Justified.** Destructuring. |
| `VaultFactory._requireNoHooks` ignores `info` from v4 `getPoolAndPositionInfo` (line 268) | **Justified.** Only the `PoolKey`'s `hooks` field is needed, as in `PositionVault.currencies`. New with the Q21 fix. |
| `DeployR1.deploy` ignores the call mode and `tx.origin` from `vm.readCallers()` (`script/DeployR1.s.sol` line 77) | **Justified.** Only the broadcasting sender is needed. |
| `DeployR1._checkKey` ignores the pending value from `pendingOf` (line 165) | **Justified.** The check needs only "no change pending". `FeeController` sets and clears `pendingValue` and `pendingAt` together (`setFee`, `applyPending`), so `pendingAt == 0` means nothing is pending. |

### `missing-zero-check` (2)

| Finding | Triage |
|---|---|
| `LockVault.transferOwnership(to)` (`src/vault/LockVault.sol` line 89) | **Justified, intended.** `address(0)` cancels a pending transfer (NatSpec line 87); a new call replaces it. Ownership moves only when `pendingOwner` calls `acceptOwnership`, and nobody can send from `address(0)` (THREAT-MODEL Q17). Tested by `test_transferOwnership_ownerOnly_andCanBeCancelledOrReplaced`. |
| `PositionVault.transferOwnership(to)` (`src/vault/PositionVault.sol` line 154) | **Justified.** The same (NatSpec line 153; `test_transferOwnership_toZero_cancels`). |

### `calls-loop` (8, all in the script)

| Finding | Triage |
|---|---|
| `DeployR1._checkKey`: `feeOf`, `capOf`, `pendingOf` inside the key loop, reported once per call stack (6 findings; `script/DeployR1.s.sol` lines 152-178) | **Justified.** A deployment script over a fixed list of five keys, against the FeeController the deployer owns. A revert inside the loop is meant to stop the run before any transaction is sent (lines 82-87). |
| `DeployR1.deploy`: `fees.addKey` inside the loop (2 findings; line 122) | **Justified.** The same five keys. A failed `addKey` must stop the script, and continue mode (`ARCOS_R1_CONTINUE`) resumes it (`test/DeployR1.t.sol`). |

### `reentrancy-benign` (2)

| Finding | Triage |
|---|---|
| `VaultFactory.lockToken` writes the registries after calling the fee recipient (`_takeFlatFee`) and the new clone's `initialize` (`src/vault/VaultFactory.sol` lines 101-128) | **Justified.** `lockToken` is `nonReentrant` (transient guard), so a recipient that calls back into `lockToken` or `lockPosition` reverts (`test_lockToken_isNonReentrant_forAReenteringFeeRecipient`). The factory's only other state-changing function is `setManager`, which is `onlyOwner`. The `initialize` callee is a clone of the factory's own implementation, made in this call. The write order matters only to a reader of `isVault` or the registries during the call (THREAT-MODEL Q6). |
| `VaultFactory.lockPosition`, the same pattern (lines 143-165) | **Justified.** The same reasons. The `currencies()` read, the NFT transfer and the principal and hooks reads in `lockPosition` go to the allow-listed manager, and the call is `nonReentrant`. |

### `timestamp` (8)

| Finding | Triage |
|---|---|
| `LockVault.withdraw`: `block.timestamp < unlockAt` (`src/vault/LockVault.sol` line 80) | **Justified.** A lock is measured in days, up to 3650. The few seconds a block producer can shift a timestamp don't matter, and Arc's blocks come about every 0.5 s. |
| `LockVault._requireInWindow` (line 105) | **Justified.** The same: the window is (now, now + 3650 days]. |
| `PositionVault.withdraw` (`src/vault/PositionVault.sol` line 147) | **Justified.** The same. |
| `PositionVault._requireInWindow` (line 249) | **Justified.** The same. |
| `VestingFactory.createVesting`: the schedule bounds (`src/vesting/VestingFactory.sol` line 83) | **Justified.** Bounds of days to years (`start <= now + 3650 days`). The vesting curve itself is OpenZeppelin's, also timestamp-based. |
| `ProPass.isPro` (`src/ProPass.sol` line 38) | **Justified.** Pro time is sold in 30-day months. |
| `ProPass.subscribe` (line 51) | **Justified.** The same: whether to extend from `paidUntil` or from now. |
| `FeeController.applyPending` (`src/FeeController.sol` line 76) | **Justified.** A 48-hour notice on fee increases. |

### `assembly` (1)

| Finding | Triage |
|---|---|
| `PositionVault._tryPayPlatform`: two `call`s in assembly (`src/vault/PositionVault.sol` lines 229-231, 236-240) | **Justified, intended.** Solidity's `call` copies all return data into memory. Assembly caps what the fee recipient, or a token acting for it, can cost the owner: at most 100,000 gas, and at most 32 bytes copied back, into scratch space (so `memory-safe` holds). The success rule after it (line 241) is SafeERC20's: no return data from a contract, or at least one word whose value is 1. Tested for each failure mode by the `test_q9_*` tests, including a megabyte of return data and about 150 KB. THREAT-MODEL Q9 and Q20 cover the design. |

### `low-level-calls` (6)

| Finding | Triage |
|---|---|
| `VaultFactory._takeFlatFee`: `feeTo.call{value: fee}("")` (`src/vault/VaultFactory.sol` line 280) | **Justified.** The native fee to the owner-set recipient; `ok` is checked and a failure reverts `FeeTransferFailed`. |
| `VaultFactory._isV2Pair`: three `staticcall`s to the token (lines 290-292) | **Justified, intended.** Shape detection must survive a token that lacks these functions or reverts, so it can't use typed calls. `staticcall` can't change state. A hostile token can only make its own lock more expensive (THREAT-MODEL Q18). |
| `PositionVault._split`: `payable(owner).call{value: toOwner}("")` (`src/vault/PositionVault.sol` line 211) | **Justified.** Pays the owner's native share. `ok` is checked, and a failure reverts `NativeTransferFailed`, so the owner's value is never silently dropped. An owner who can't receive native value can't collect until ownership moves (THREAT-MODEL Q26). |
| `ProPass.subscribe`: the fee to the recipient (`src/ProPass.sol` line 57) | **Justified.** Checked; reverts `FeeTransferFailed`. |
| `VestingFactory.createVesting`: the fee to the recipient (`src/vesting/VestingFactory.sol` line 102) | **Justified.** Checked; reverts `FeeTransferFailed`. |
| `DeployR1._checkWired`: `staticcall` of a key getter (`script/DeployR1.s.sol` line 194) | **Justified, intended.** A contract without that getter must be refused with a clear message, not a raw revert. The result is then checked for exactly 32 bytes holding the expected key. |

## Nothing to report

No finding points to a defect, so no contract change follows from this run. The questions Slither's findings touch
(Q6, Q9, Q17, Q18, Q20, Q26) are open to the auditor in `THREAT-MODEL.md`.
