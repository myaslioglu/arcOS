# Invariants: 4rc.OS R1 contracts

What the in-scope contracts must always keep, and the test that enforces each. Paths are under
`packages/contracts/test/`. How to run the tests is in `SCOPE.md`.

Kinds of test:
- **invariant**: a Foundry invariant campaign over a handler that drives random sequences of actions by random
  actors. Every handler keeps an exact ledger, predicts the outcome of each action (who may call, when, who is paid
  what), and sets a flag that never clears when reality differs. `fail_on_revert` is on, so the handler catches every
  call into the contracts; a revert that reaches the fuzzer is a handler bug. Each suite has a scripted test
  (`test_handler_every...`) that runs every action once and asserts it succeeded, so an idle handler can't pass
  vacuously.
- **fuzz**: a property test, 512 runs by default.
- **unit**: a fixed scenario.
- **fork**: against the real Uniswap managers on a fork of Arc mainnet (`npm run test:fork`; not in the default run).

| Suite | Runs x depth | Invariants |
|---|---|---:|
| `vault/VaultInvariants.t.sol` (LockVault, VaultFactory ERC-20 locks) | 1000 x 64 | 7 |
| `vault/PositionInvariants.t.sol` (PositionVault, VaultFactory position locks, v3, v4 and v4-native mock pools) | 1000 x 64 | 6 |
| `vesting/VestingInvariants.t.sol` (ArcVesting, VestingFactory, a plain and a 1%-taxed token) | 500 x 64 | 6 |

The implementers also mutation-tested these suites (their counts, not re-run for this package):
- vault ERC-20 locks: all 13 invariant-only mutants killed;
- position locks: 62 mutants, all killed but 2 judged equivalent;
- vesting: 52 of 54 killed by the fast suites, the other 2 equivalent; the invariants alone killed 11 of 12;
- the 2026-10-02 changes (hooked v4 pools refused, `renounceOwnership` disabled), run for that update: 10 hand-made
  mutants, all killed by the unit suites. The hook check removed, applied to v3 instead of v4 or to both, inverted,
  testing another PoolKey field, or testing only the permission bits; each `renounceOwnership` override restored to
  OpenZeppelin's or stripped of `onlyOwner`.

## The listed invariants

The five properties the audit package was asked to state, and where each is enforced. **Gap** marks a part no test
enforces.

### 1. PositionVault: the principal can't leave before `unlockAt`

Neither the NFT nor its liquidity leaves a position vault before `unlockAt`, by any path: through the vault, or
straight through the manager.

| Test | Kind |
|---|---|
| `vault/PositionInvariants.t.sol` `invariant_theNftStaysInTheVaultUntilWithdrawn`: an unwithdrawn NFT is held by its vault, and every withdraw happened at or after the unlock time of that moment | invariant |
| `vault/PositionInvariants.t.sol` `invariant_liquidityNeverDecreases`: every position keeps exactly its starting liquidity | invariant |
| The same handler's `attack` action: anyone, the owner included, tries `decreaseLiquidity`, NFT transfers, approvals and `collect` straight on the manager; any success sets the flag read by `invariant_noUnexpectedOutcome` | invariant |
| `vault/PositionFuzz.t.sol` `testFuzz_nonOwnerNeverReceivesValue_ownerNeverGetsThePositionEarly` | fuzz |
| `vault/PositionVault.t.sol` `test_withdraw_oneSecondBefore_reverts_atUnlock_sendsThePosition`, `test_theManagerRefusesEveryoneButTheVault`, `test_anApprovalGivenBeforeTheLock_doesNotSurvive`, `test_collect_v4_erc20_splitsByTheShare_andDecreasesByZero` | unit |
| `vault/PositionFactory.t.sol` `test_lockPosition_refusesAPositionWithNoLiquidity`, `test_lockPosition_v3_refusesPrincipalWaitingInTokensOwed_untilCollected`, `test_lockPosition_refusesWhenTheManagerDidNotDeliverTheNft` (a lock always starts with principal in it) | unit |
| `vault/PositionFactory.t.sol` `test_lockPosition_v4_refusesAPoolWithHooks_andLeavesNothing`, `testFuzz_lockPosition_v4_refusesEveryHookAddress` (no v4 lock has a hook that could run on its `collect`; THREAT-MODEL Q21) | unit, fuzz |
| `fork/PositionVault.fork.t.sol` `test_v3_everyEarlyExitFails_thenTheOwnerWithdrawsAWorkingPosition`, and the `v4` and `v4Native` versions; `test_lockPosition_refusesAV4PositionInAPoolWithHooks` (a live hook on the deployed PoolManager) | fork |

The invariant and fuzz tests run against mock managers that model Uniswap's access rules. **Gap:** on the real
managers, the property is checked by the fork scenarios only, not by an invariant or fuzz campaign.

### 2. PositionVault: only the owner collects or withdraws

Only the vault's owner can call `collect` and `withdraw`. `collect` pays exactly two parties: the owner, and the
recipient copied at creation, `floor(amount * feeShareBps / 10_000)`.

| Test | Kind |
|---|---|
| `vault/PositionInvariants.t.sol` `invariant_noUnexpectedOutcome`: the handler predicts a refusal for every non-owner `collect` and `withdraw`, predicts the exact split, and flags anyone else being paid | invariant |
| `vault/PositionInvariants.t.sol` `invariant_theRecipientGetsExactlyItsShares`: the recipient's native receipts equal the flat fees plus the predicted shares, and no vault keeps native value | invariant |
| `vault/PositionFuzz.t.sol` `testFuzz_collect_splitsExactly`, `testFuzz_nonOwnerNeverReceivesValue_ownerNeverGetsThePositionEarly` | fuzz |
| `vault/PositionVault.t.sol` `test_collect_isOwnerOnly`, `test_withdraw_isOwnerOnly_andRefusesZero`, `test_collect_platformShareRoundsDown`, `test_collect_usesTheShareAndRecipientCopiedAtCreation` | unit |

### 3. LockVault: the balance leaves only by the owner's withdraw

Also stated as "LockVault's monotonic balance". Precisely:
- while a vault is locked, its balance never goes down;
- at all times it equals what was locked, plus what was sent to it, minus what its owner withdrew;
- after a withdraw it is empty.

| Test | Kind |
|---|---|
| `vault/VaultInvariants.t.sol` `invariant_heldByVaultsEqualsLockedMinusWithdrawn`: each vault matches its ledger exactly, and the totals per token match | invariant |
| `vault/VaultInvariants.t.sol` `invariant_noNonOwnerCallMovesTokens` | invariant |
| `vault/VaultInvariants.t.sol` `invariant_noVaultHoldsTokensAfterAWithdraw` | invariant |
| `vault/VaultInvariants.t.sol` `invariant_noUnexpectedOutcome`: a `withdraw` before `unlockAt` or by a non-owner must revert and move nothing | invariant |
| `vault/VaultFuzz.t.sol` `testFuzz_lockThenWithdraw_roundTrip`, `testFuzz_nonOwnerNeverReceivesValue_ownerNeverBeforeUnlock` | fuzz |
| `vault/LockVault.t.sol` `testFuzz_withdraw_neverBeforeUnlock`, `testFuzz_strangerCanCallNothing` | fuzz |
| `vault/LockVault.t.sol` `test_withdraw_revertsOneSecondBeforeUnlock_andSucceedsAtUnlock`, `test_withdraw_isOwnerOnly`, `test_withdraw_isNotReentrant` | unit |

This holds for tokens that behave. A token that rebases down, taxes transfers or confiscates can change a vault's
balance by itself (THREAT-MODEL Q1, Q3). `vault/VaultTokens.t.sol` pins what happens then:
`test_rebasing_liveBalanceGoesDown`, `test_feeOnTransfer_vaultReleasesWhatItHolds_tokenTaxesTheExitToo`. The
invariant suite uses a plain token and a pair-shaped one.

### 4. The factories hold nothing

No token, NFT or native value rests in `VaultFactory`, `VestingFactory` or `ProPass` after a call.

| Contract, path | Test | Kind |
|---|---|---|
| `VaultFactory`, ERC-20 locks | `vault/VaultInvariants.t.sol` `invariant_userFundsAreConserved_andTheFactoryHoldsNothing`: what lockers paid equals what was locked plus the LP fee, and the factory holds no token and no native value | invariant |
| `VaultFactory`, failed locks | `vault/VaultTestBase.sol` `_assertNothingLeftBehind`, used by the refusal tests | unit |
| `VaultFactory`, position locks | the position handler flags any lock after which the NFT is not in the new vault (read by `invariant_noUnexpectedOutcome`); `vault/PositionFactory.t.sol` `test_lockPosition_v3_registersUnderTheOwnerAndBothCurrencies` asserts the factory's native balance is zero | invariant (NFT); unit (native) |
| `VestingFactory` | `vesting/VestingInvariants.t.sol` `invariant_factoryAndWalletsHoldNoValue_andTheFactoryHoldsNoTokens`, which also checks every fee was forwarded | invariant |
| `ProPass` | `ProPass.t.sol` `testFuzz_paidUntilIsMonotonic_andEachCallAddsExactlyItsMonths`, `testFuzz_onlyTheExactFeeIsAccepted` (the pass's balance stays zero) | fuzz |

**Gap:** the factory's native balance after position locks is asserted in a unit test only. The position invariant
suite doesn't check it.

### 5. Fees never exceed their caps

A fee is never above its cap. Every call charges exactly the current `feeOf`: the flat fee sent exactly, the LP fee
rounded down. A bps value above 10,000 is refused, never truncated. A fee change never reaches an existing lock.

| Part | Test | Kind |
|---|---|---|
| `feeOf <= capOf`, whatever the owner sets and whenever it is applied | `FeeController.t.sol` `testFuzz_feeNeverExceedsCap`, `test_setFee_neverExceedsCap`, `test_addKey_rejectsDuplicateAboveCapAndStrangers`, `test_increase_waitsForDelay` | fuzz, unit |
| Each call charges exactly the current fee | the vault, position and vesting handlers predict the flat fee and the LP-fee floor, and `changeFee` / `changeShare` move fees within their caps during the campaigns (`invariant_noUnexpectedOutcome`, `invariant_userFundsAreConserved_andTheFactoryHoldsNothing`, `invariant_theRecipientGetsExactlyItsShares`); `vault/VaultFees.t.sol` `testFuzz_lpFee_isFlooredExactly`, `testFuzz_lpFee_isMonotoneAndStepsByAtMostOne`; `vesting/VestingFuzz.t.sol` `testFuzz_onlyTheExactFeeIsAccepted`; `ProPass.t.sol` `testFuzz_onlyTheExactFeeIsAccepted` | invariant, fuzz |
| A bps value above 10,000 is refused | `vault/VaultFees.t.sol` `test_lpFee_bpsAboveTenThousand_reverts_butTeamTokensAreUnaffected`; `vault/VaultFactory.t.sol` `test_lockPosition_rejectsAFeeShareAboveTenThousandBps`; `vault/PositionVault.t.sol` `test_initialize_rejectsAFeeShareAboveTenThousandBps` | unit |
| A later change never touches an existing lock | `vault/VaultFees.t.sol` `test_laterFeeChange_neverTouchesAnExistingLock`; `vault/PositionVault.t.sol` `test_collect_usesTheShareAndRecipientCopiedAtCreation`; the position handler's `changeShare`, after which new locks copy the new share and old ones keep theirs | unit, invariant |
| The deployed caps are the stated ones | `DeployR1.t.sol` (each key's fee and cap) | unit |

**Gap:** no single campaign combines the two halves. The handlers only ever set fees within their caps, and the
refusal above a cap is tested on `FeeController` alone. Together the parts cover the property, since every in-scope
contract reads fees only through `feeOf`.

## Every invariant the suites enforce

### `vault/VaultInvariants.t.sol` (LockVault and VaultFactory ERC-20 locks)

| Invariant | Statement |
|---|---|
| `invariant_heldByVaultsEqualsLockedMinusWithdrawn` | Each vault holds exactly its ledger amount; per token, the vaults hold locked + donated - withdrawn |
| `invariant_noVaultHoldsTokensAfterAWithdraw` | A successful withdraw leaves the vault empty |
| `invariant_noNonOwnerCallMovesTokens` | No call by a non-owner moves tokens |
| `invariant_unlockAtNeverDecreases` | `unlockAt` never goes down |
| `invariant_userFundsAreConserved_andTheFactoryHoldsNothing` | Paid = locked + LP fees; the factory holds no token and no native value |
| `invariant_registriesMatchTheLedger` | Every vault is registered once where it was made; registry lengths match; no position entries |
| `invariant_noUnexpectedOutcome` | Every lock, extend, withdraw, ownership step, donation and fee change did what the handler predicted: right owner, token, time, flat fee forwarded, LP fee the floor |

### `vault/PositionInvariants.t.sol` (PositionVault and VaultFactory position locks)

The handler drives:
- locks on three pool kinds;
- fee accrual, `collect`, `extend`, `withdraw`, and both ownership steps;
- a fee recipient that turns hostile (reverts, burns gas, returns a megabyte) and recovers;
- share changes, time passing, and direct attacks on the managers.

| Invariant | Statement |
|---|---|
| `invariant_theNftStaysInTheVaultUntilWithdrawn` | See listed invariant 1 |
| `invariant_liquidityNeverDecreases` | See listed invariant 1 |
| `invariant_unlockAtNeverDecreases` | `unlockAt` never goes down |
| `invariant_theRecipientGetsExactlyItsShares` | The recipient's native receipts equal the flat fees plus the predicted shares; no vault keeps native value |
| `invariant_everyVaultIsRegisteredUnderBothCurrencies` | Every vault is in `positionVaultsForToken` under both currencies (`address(0)` for native) and `isVault` |
| `invariant_noUnexpectedOutcome` | Every action matched its prediction. This includes the exact owner and platform amounts per currency, the skip when the recipient fails, refusals for non-owners and early withdraws, and every attack on a manager failing |

### `vesting/VestingInvariants.t.sol` (ArcVesting and VestingFactory)

| Invariant | Statement |
|---|---|
| `invariant_releasedPlusHeldEqualsFunded` | released + releasable + unreleased = funded, and released + releasable equals an independent reference curve |
| `invariant_nothingReleasedBeforeTheCliff` | Before `cliff()`, nothing is released or releasable |
| `invariant_nothingMoreThanFunded` | Nothing releases or vests beyond what was funded; owners received exactly what was released |
| `invariant_factoryAndWalletsHoldNoValue_andTheFactoryHoldsNoTokens` | No native value in the factory or any wallet; `releasable()` (native) is zero; every fee was forwarded |
| `invariant_registriesMatchTheLedger` | Registry lengths match; every wallet is `isVesting` |
| `invariant_noUnexpectedOutcome` | Every action matched its prediction. Vested amounts never decreased; invalid creations reverted and left nothing behind; native releases were refused |

## Fuzz properties

| Test | Property |
|---|---|
| `vault/LockVault.t.sol` `testFuzz_withdraw_neverBeforeUnlock` | No withdraw before `unlockAt` |
| `vault/LockVault.t.sol` `testFuzz_strangerCanCallNothing` | A non-owner can't extend, withdraw, start a transfer or accept one, before or after `unlockAt` |
| `vault/LockVault.t.sol` `testFuzz_extend_neverShortens` | `extend` only lengthens, within the window |
| `vault/VaultFuzz.t.sol` `testFuzz_lockThenWithdraw_roundTrip` | What goes in comes back out at `unlockAt`; the factory keeps nothing |
| `vault/VaultFuzz.t.sol` `testFuzz_lockToken_unlockTimeBounds` | Only unlock times in (now, now + 3650 days] are accepted |
| `vault/VaultFuzz.t.sol` `testFuzz_nonOwnerNeverReceivesValue_ownerNeverBeforeUnlock` | As named |
| `vault/VaultFuzz.t.sol` `testFuzz_ownerKeyCannotShortenALock` | No sequence of owner calls shortens a lock |
| `vault/VaultFees.t.sol` `testFuzz_lpFee_isFlooredExactly` | The LP fee equals an independent floor |
| `vault/VaultFees.t.sol` `testFuzz_lpFee_isMonotoneAndStepsByAtMostOne` | The LP fee grows with the amount, by at most one unit a step |
| `vault/VaultRegistry.t.sol` `testFuzz_slice_matchesAReference_anyStartAndCount`, `testFuzz_slice_matchesAReference_nearTheList` | Slices match a reference and never revert |
| `vault/PositionFuzz.t.sol` `testFuzz_collect_splitsExactly` | The split is exact for any share and amounts |
| `vault/PositionFuzz.t.sol` `testFuzz_nonOwnerNeverReceivesValue_ownerNeverGetsThePositionEarly` | As named |
| `vault/PositionFuzz.t.sol` `testFuzz_extend_onlyLengthens` | As named |
| `vault/PositionFactory.t.sol` `testFuzz_lockPosition_v4_refusesEveryHookAddress` | Any non-zero hooks address is refused; the same position without hooks locks |
| `vesting/VestingFuzz.t.sol` `testFuzz_curveMatchesTheReference` | The vesting curve equals a `mulDiv` reference, rounding down |
| `vesting/VestingFuzz.t.sol` `testFuzz_vestedIsMonotonicInTime` | Vested never decreases over time |
| `vesting/VestingFuzz.t.sol` `testFuzz_releasesFollowTheSchedule` | At random moments, releases equal the reference curve, the beneficiary holds exactly what was released, and nothing appears or vanishes |
| `vesting/VestingFuzz.t.sol` `testFuzz_scheduleValidation` | Exactly the documented schedules are accepted |
| `vesting/VestingFuzz.t.sol` `testFuzz_onlyTheExactFeeIsAccepted` | As named |
| `vesting/VestingFuzz.t.sol` `testFuzz_slicesMatchTheWholeList` | As named |
| `ProPass.t.sol` `testFuzz_paidUntilIsMonotonic_andEachCallAddsExactlyItsMonths` | `paidUntil` only grows, by exactly the months paid |
| `ProPass.t.sol` `testFuzz_onlyTheExactFeeIsAccepted` | As named |
| `ProPass.t.sol` `testFuzz_badMonthsAlwaysRevert` | 0 and more than 24 months revert |
| `FeeController.t.sol` `testFuzz_feeNeverExceedsCap` | See listed invariant 5 |

## Other properties, by unit test only

- **Implementations and clones.** No implementation can be initialised, and a clone initialises once:
  `vault/LockVault.t.sol` `test_implementation_cannotBeInitialised`, `test_initialize_cannotBeCalledTwice`;
  `vault/PositionVault.t.sol` `test_implementation_cannotBeInitialised`, `test_initialize_runsOnce_andStoresWhatItWasGiven`;
  `vault/VaultFactory.t.sol` `test_constructor_deploysBothImplementations_initialiserDisabled`,
  `test_lockToken_vaultIsAFixedMinimalProxy`.
- **One vault per lock.** `vault/VaultFactory.t.sol` `test_lockToken_twoLocksGetTwoVaults_noSharedPool`.
- **Re-entry.** `vault/VaultFactory.t.sol` `test_lockToken_isNonReentrant_forAHostileToken`,
  `test_lockToken_isNonReentrant_forAReenteringFeeRecipient`; `vault/PositionVault.t.sol`
  `test_collect_isNotReentrant`, `test_withdraw_isNotReentrant`.
- **The vesting native path is closed** (USDC's two views): `vesting/ArcVesting.t.sol`
  `test_usdcsTwoViews_cannotBeReleasedTwice`, `test_nativeRelease_isClosed_andNothingNativeIsReleasable`,
  `test_nativeValueIsRefused`.
- **No v4 lock has hooks** (THREAT-MODEL Q21): `lockPosition` refuses a v4 position whose PoolKey names a hook
  contract, and nothing is left behind. `vault/PositionFactory.t.sol`
  `test_lockPosition_v4_refusesAPoolWithHooks_andLeavesNothing`, `testFuzz_lockPosition_v4_refusesEveryHookAddress`;
  `fork/PositionVault.fork.t.sol` `test_lockPosition_refusesAV4PositionInAPoolWithHooks`.
- **Ownership can't be renounced** on `VaultFactory`, `ArcVesting` or `FeeController` (THREAT-MODEL Q7, V2): the
  owner gets `RenounceDisabled`, a stranger `OwnableUnauthorizedAccount`, and nothing changes.
  `vault/VaultFactory.t.sol` `test_renounceOwnership_alwaysReverts_ownerUnchanged_setManagerStillWorks`,
  `test_renounceOwnership_byAStranger_isUnauthorized`, `test_renounceOwnership_staysDisabled_afterOwnershipMoves`;
  `vesting/ArcVesting.t.sol` `test_renounceOwnership_alwaysReverts_releasesStillPayTheOwner`,
  `test_onlyTheOwnerCanTransferTheWallet`; `FeeController.t.sol`
  `test_renounceOwnership_alwaysReverts_ownerUnchanged_setRecipientStillWorks`.
- **The platform share never blocks the owner** (THREAT-MODEL Q9): the 19 `test_q9_*` tests in
  `vault/PositionVault.t.sol`, including `test_q9_theOwnerCannotStarveARecipientThatNeedsAllOfTheBudget`.

## Not enforced by any local test

- **USDC at `0x3600`.** Its gas cost inside the 100,000-gas share budget, and a transfer to a contract whose
  `receive` reverts (THREAT-MODEL Q25, T1). Forks can't move `0x3600`, and the vesting two-view tests use a mock.
  Settled on testnet after the deployment.
- **Arc's blocklist** (Q16, Q26, T2). The tests model a blocked address with mock tokens and receivers only.
