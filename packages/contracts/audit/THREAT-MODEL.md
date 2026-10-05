# Threat model: 4rc.OS R1 contracts

Scope and versions are in `SCOPE.md`; the properties and their tests are in `INVARIANTS.md`. File references are
to `packages/contracts/`.

## The design in one paragraph

Each lock is its own contract. `VaultFactory` makes an EIP-1167 clone of `LockVault` (an ERC-20 lock) or of
`PositionVault` (a Uniswap v3 or v4 position NFT) for every lock, and moves the asset from the caller straight into
it in the same transaction. There is no shared pool, no admin over a vault, no upgrade path and no rescue function.
The only way principal leaves a vault is `withdraw`, by the vault's owner, at or after `unlockAt`. `VestingFactory`
deploys a full `ArcVesting` contract (OpenZeppelin's `VestingWalletCliff`) per schedule and funds it in the same
transaction. `ProPass` records prepaid time and forwards each payment. The fees come from R0's `FeeController`, are
paid as native USDC, and are forwarded in the same call. Nothing in scope holds a fee.

## Actors

| Actor | Can | Cannot |
|---|---|---|
| **Lock owner** (`LockVault.owner`, `PositionVault.owner`) | `extend` (only later, in the future, at most 3650 days out); `withdraw(to)` at or after `unlockAt`; on a position, `collect` fees at any time; start and cancel a two-step ownership transfer | shorten a lock; move principal before `unlockAt`; change the fee share or recipient copied into a position vault |
| **Pending owner** | `acceptOwnership` | anything else |
| **Lock creator** (the caller of `lockToken` / `lockPosition`) | pay the flat fee; lock their own tokens or their own position NFT for any `owner_`, any `unlockAt` in the window | lock a token or NFT they don't hold or haven't approved; the NFT is always taken from `msg.sender` |
| **Vesting creator** (the caller of `createVesting`) | fund a schedule for any beneficiary, token, start (up to 3650 days out, or in the past), duration and cliff | take anything back: a schedule can't be cancelled |
| **Beneficiary** (`ArcVesting.owner()`) | receive releases; transfer the wallet in one step (so sell it, unvested tokens included) | change the schedule; release more than has vested; renounce ownership (disabled, V2) |
| **Anyone** | call `release(token)` on any wallet (the tokens go to its owner); create locks and schedules for anyone, and so pad the registries; send tokens to a vault or wallet; clone the public implementations; pay `ProPass` for any account; apply a fee increase whose delay has passed (`FeeController.applyPending`); add liquidity to a locked v3 position (Q22) | move value out of a vault or a wallet to anyone but its owner |
| **Fee recipient** (`FeeController.recipient()`) | receive the flat fees, the LP fee and the position share | reach a vault. A recipient that reverts blocks new locks, schedules and subscriptions (Q9, V11); in a position vault it is skipped instead (Q9) |
| **FeeController owner** | add a key; lower a fee at once; raise a fee up to its cap after 48 hours; change the recipient | exceed a cap; renounce ownership (disabled); change a fee already charged, or the share and recipient already copied into a position vault |
| **VaultFactory owner** | allow or disallow a position manager and set its kind, for new position locks only (`setManager`); transfer ownership in two steps | touch an existing vault, lock or fee; renounce ownership (disabled, Q7) |
| **Allow-listed position manager** (Uniswap v3 `NonfungiblePositionManager`, v4 `PositionManager`) | report a position's currencies, liquidity and owed amounts; transfer the NFT; pay out fees on `collect` | nothing more is granted, but a hostile manager could lie about all of that (Q8, Q24) |
| **Token issuers** (a locked token, a vested token, a pool currency) | freeze, blocklist, confiscate, pause, tax transfers, rebase, lie about balances; make a token look like a v2 pair (Q18); refuse the fee recipient (Q19); raise its own transfer gas (Q28); re-enter on transfer | reach other tokens' locks |
| **v4 hooks** | nothing on a locked position: `lockPosition` refuses a v4 position whose pool has a hook contract (Q21), and a pool's hooks never change | run on a locked position's `collect`; block `withdraw`, which is a plain NFT transfer |
| **Arc and Circle** | blocklist an address for USDC (both views); define how the two USDC views behave | nothing on the contracts themselves |
| **Deployer** (the `DeployR1` sender) | add R1's fee keys and deploy; becomes the VaultFactory's owner. The script refuses to start unless the sender owns the FeeController, and runs all its checks before its first transaction | nothing beyond the FeeController owner's and the VaultFactory owner's powers |

## Assets

1. **Locked ERC-20 tokens** in `LockVault`s: team tokens and Uniswap-v2-style LP tokens.
2. **Locked positions** in `PositionVault`s: the NFT and its liquidity (the principal), plus the fees in transit
   during a `collect`.
3. **Vesting tokens** in `ArcVesting` wallets.
4. **Fees in transit**: the native flat fees and `ProPass` payments, the LP fee in the locked token, the position
   share in the pool's currencies. None rests in a contract.
5. **Proof data** other software trusts: `isVault`, `isVesting`, the registries, the events, each vault's `owner()`,
   `unlockAt`, `lockedAmount()` and `liquidity()`, and `ProPass.paidUntil`. Inspector shows a token's lock from them.
6. **Control**: FeeController ownership (fee levels, the recipient) and VaultFactory ownership (the allow-list).

## Trust assumptions

- **The locked token is trusted for itself.** A vault holds whatever the token says it holds and moves it with the
  token's own `transfer`. A token that can freeze, confiscate, pause, rebase down or lie defeats any lock of it
  (Q1). The design limits the damage to that token's own locks.
- **Allow-listed managers are the real Uniswap deployments.** The vault believes its manager about ownership,
  liquidity, owed amounts and currencies. The VaultFactory owner is trusted to allow-list only those (Q8, Q24).
- **Uniswap behaves as documented.** A v3 `collect` and a v4 zero-liquidity `DECREASE_LIQUIDITY` followed by
  `TAKE_PAIR` pay fees without touching principal. A v4 pool's hooks are fixed in its PoolKey, so a position that
  was hookless when locked stays hookless. An NFT's owner alone can decrease, burn, transfer or approve it. The
  fork suite checks these on the live deployments.
- **The FeeController owner is honest within its caps.** It can raise fees only to the caps and only after 48
  hours, can set a fee to zero (T5), and chooses the recipient. It is meant to be a Safe before mainnet.
- **The fee recipient is a plain account.** A position vault gives the recipient 100,000 gas per payment; a
  recipient that needs more is skipped (Q20).
- **Arc's USDC keeps its two views in step**, and the chain supports TSTORE/TLOAD (checked).
- **Readers check each contract's own state.** Registries are discovery hints. `isVault` and `isVesting` are the
  only proof that a contract was made here, and `owner()` is the only truth about who controls it (Q4, Q5, Q14, V1).
  `PositionVault.liquidity()` and `currencies()` revert for a v3 position burned after `withdraw`, so readers must
  handle a revert.

## Past locker exploits, and what one contract per lock changes

Lockers on other chains have been drained before. Three incidents are summarised below from public post-mortems,
with what this design does about each, followed by the attack classes they belong to. Dates and amounts are as the
cited sources report them; where the sources differ, both figures are given.

**GemPad, 17 December 2024, about $1.8M** (Decurity; Halborn puts it at about $1.9M), on Ethereum, BNB Chain and
Base. One contract, `GemPadLock`, held every user's locked LP tokens and kept the books for them. The attacker
locked a Uniswap v3 position paired with a token of their own whose `transfer` re-enters the locker, then called
`collectFees`; inside the manager's `collect`, the token re-entered `multipleLock`, which credited new locks with a
balance difference the locker measured around the re-entry, that is, with other users' tokens. The attacker
unlocked them in the next block. *Here:* every factory and vault entry point that calls out is `nonReentrant`, and
the vault that a hostile token reaches holds only that lock's own asset. `lockToken` records the balance delta of
the new vault, not of a shared pool, and `collect` splits only the collecting vault's own balance, so a re-entering
token can't count anyone else's tokens as its own.
Sources: https://www.decurity.io/research/gempad-incident-deep-dive,
https://www.halborn.com/blog/post/explained-the-gempad-hack-december-2024

**DxSale, late May 2026, about $7.3M**, on BNB Chain. A 2021 (v1) locker contract held the LP tokens of more than 1,400
pools. BlockSec traces the drain to its `unlockToken`: the lock period was checked with an `if` rather than a `require`,
the locked amount was not zeroed after a withdrawal, and the balance check read the contract's whole balance rather than
the caller's lock, so one lock could be withdrawn again and again until the shared balance was gone. rekt.news
reports that the locker's owner key had passed to the attacker; BlockSec reports the attacker used it to set the lock
fee and says the key compromise was not a prerequisite. *Here:* `withdraw` sends only what the vault itself holds (its live balance,
or its one NFT), only at or after `unlockAt`, and only when the vault's owner calls it; the time check reverts
(`StillLocked`). There are no books to leave unzeroed: a repeated withdrawal finds nothing left to send. The
VaultFactory owner has no power over any vault, and a fee change reaches new locks only.
Sources: https://blocksec.com/blog/web3-security-dxsale-squidrouter-more, https://rekt.news/dxsale-rekt

**Team Finance, 27 October 2022, $15.8M** per rekt.news, citing PeckShield (Halborn puts it at about $14.5M), on
Ethereum. Team Finance's liquidity-lock contract had a `migrate` function, added so projects could move locked Uniswap
v2 liquidity to v3. By locking a token in the contract, the attacker got past `migrate`'s validation, then migrated
other projects' locked v2 liquidity, held by the same contract, into v3 pools they had set up at a skewed price, and
kept the difference that the migration refunded. The function had been in an audit's scope. *Here:* there is no migrate,
rescue or admin function; nothing moves a lock's asset into a new pool or to anyone but the vault's owner, and
`packages/chain/src/__tests__/abis.test.ts` pins every vault's exact function list. Sources:
https://rekt.news/teamfinance-rekt, https://halborn.com/explained-the-team-finance-hack-october-2022/

The attack classes, and what this design does to each:

1. **A flaw that releases more than the caller's own deposit** (DxSale's `unlockToken`, GemPad's re-entered
   books). In a shared pool, the contract's books decide whose tokens a call may move: a wrong index, a missing
   ownership check or an accounting error reaches every user's deposit, often in one transaction. Here each vault
   holds one lock's asset and keeps no books: `withdraw` sends the vault's own balance (or its one NFT) to the
   vault's own owner. A flaw of this kind can reach only the vault it is called on. *What it does not change:* all
   clones run one implementation, so a flaw in its own checks (the owner check or the time check) would hold in
   every vault. It would still have to be exploited vault by vault, and those checks are exactly what the invariant
   suites attack.
2. **A privileged path** (Team Finance's `migrate`, DxSale's owner key). An emergency withdrawal, a migration
   function, an upgradeable proxy or an admin key that can move pooled assets. Once its key is stolen or its logic
   is abused, it empties the pool. Here there is none: no admin function over a vault, no upgrade (clones of a fixed
   implementation whose initializer is disabled), no migrate or rescue function.
   `packages/chain/src/__tests__/abis.test.ts` pins the exact function lists of the vault, vesting and ProPass
   contracts. The VaultFactory owner can only change the allow-list for new position locks, and can't renounce. The
   FeeController owner can only change future fees within their caps.
3. **Trusting what the caller supplies** (GemPad's re-entering token, the lock Team Finance's `migrate` trusted).
   A shared contract that calls a token, pair, router or position manager the caller names can be re-entered or
   lied to, and a lie told to the pool's books costs everyone. Here a caller-supplied token can only affect the vault
   made for it, since that token is the vault's asset. Position managers are allow-listed, and a v4 pool with hooks
   is refused (Q21). Every factory and vault entry point that calls out is non-reentrant. Fees are forwarded, not
   kept.

## Questions for the auditor

These questions come from the implementers' and reviewers' notes, merged where they overlap. Each ID is the note's
own number, kept for traceability: Q1 to Q32 for the vault contracts, V1 to V14 and T1 to T5 for vesting and
ProPass, D0 for a vesting design deviation, and N1 for one added while writing this package.

Status:
- **Owner decision, open**: a product choice not yet made, so the current behaviour may change before the freeze.
- **Decided**: a choice was made; we'd like your view.
- **Fixed**: raised in review and changed in the code, with a test; listed so you can check the fix.
- **By design**: accepted and documented in NatSpec; listed so you can challenge it.
- **Decided for testnet**: accepted for the testnet deployment, to be revisited before mainnet.
- **Open until testnet**: settled by a check after the testnet deployment.

### A. Tokens

**Q1, Q2. A lock is only as strong as its token.** A token can freeze, blocklist, confiscate, pause, rebase down or
lie about `balanceOf`. `TokenLocked.amount` is a balance delta the token reports, not proof of assets.
- Status: by design.
- Why: no contract-level check can defend against the token itself. Inspector reads `lockedAmount()` and judges the
  token separately. See `LockVault.sol` lines 18-19.

**Q3, V4. Fee-on-transfer and rebasing tokens are recorded, not rejected.** `lockToken` and `createVesting` record
what arrived (the vault's or wallet's balance delta); nothing arriving reverts `ZeroAmount`. The vault keeps no amount
and `withdraw` sends its live balance. A taxed token taxes each release and the withdrawal too.
- Status: decided.
- Why: rejecting would refuse stETH-like tokens at random (a request of 1,001 lands as 1,000). Would you prefer
  rejection?

**V3. A token that rebases down after a release** can make `releasable` revert until the balance recovers or the
schedule ends.
- Status: by design, in `ArcVesting`'s NatSpec.

**Q18. `_isV2Pair` is detection by shape.** The LP fee applies when `token0()` and `token1()` return 32 bytes each and
`getReserves()` returns 96. Any ERC-20 author can answer the same way, and then everyone who locks that token pays the
LP fee (at most 1%). A real v2-fork pair whose `getReserves()` returns another length escapes the fee. The three
static calls copy whole return data, so a hostile token can make only its own lock expensive.
- Status: by design; NatSpec at `VaultFactory.sol` lines 284-288.
- Why: it harms that token's lockers only, not the factory or other tokens.

### B. Registries and proofs

**Q4, V6. Anyone can pad a registry** for any owner, beneficiary or token, at 30 USDC per lock or 20 USDC per
schedule. `vaultsOf` and `vestingsOf` record the address named at creation and don't follow ownership transfers.
- Status: by design.
- Why: readers page with `...Length` and `...Slice` (a slice clamps and never reverts) and check each entry's
  `owner()`.

**Q5. Anyone can clone the public implementations.** Only `isVault` is authoritative. A fake token with the v2 shape
gets its own registry key, so an LP-lock check must start from the real pair.
- Status: by design.

**Q6. Read-only reentrancy.** During `lockToken`, `isVault` is already true while the vault is still unfunded. The
guards cover state-changing entry points, not views.
- Status: by design.
- Question: is there a reader for whom this matters? Inspector reads outside transactions.

**T3. `release(fakeToken)` on a real wallet emits `ERC20Released`** for a token the schedule never held.
- Status: by design.
- Why: indexers key on `VestingCreated` and `isVesting`, and read `released(token)` only for the schedule's token.

**V7. Tokens already at a wallet's predicted address** before creation belong to the beneficiary but are not counted
in `VestingCreated.amount`. The same holds for a pre-funded vault address.
- Status: by design. Tested for vaults (`vault/VaultTokens.t.sol`,
  `test_preFundedPredictedAddress_isADonation_notPartOfTheRecordedAmount`); the vesting path uses the same
  balance-delta code and is not tested separately.

### C. The fee recipient and the platform's share

**Q9. What a position vault does when the recipient can't be paid.**
- Status: decided (2026-09-29, made final on 2026-10-02): the share is skipped and the owner gets everything.
- Current behaviour: `_split` (`PositionVault.sol` lines 200-216) makes one attempt with at most 100,000 gas and at
  most 32 bytes of return data copied. If it fails, `PlatformShareSkipped` is emitted and the owner gets the whole
  amount. There is no pull balance and no other function that moves tokens.
- Before the attempt, `gasleft()` must be at least `100,000 * 64 / 63 + 40,000` (about 141,587;
  `PositionVault.sol` line 225), or the call reverts `InsufficientGas`.
  That stops the owner from starving the attempt on purpose.
- Why: the platform's share must never block the owner's own fees. Every failure mode has a `test_q9_*` test.
- Alternatives we weighed: a pull balance for the recipient, or reverting the whole collect.

**Q19. A skipped share is lost for good.** A token issuer who locks their own position can make the token refuse the
fee recipient, and so keep all that token's fees.
- Status: accepted with Q9. It bounds platform revenue only.

**Q20. The 100,000-gas budget.** A recipient that needs more (a Safe with guards or modules, most contracts with logic
in `receive`) is skipped on every collect.
- Status: **owner decision, open**.
- Current rule: the recipient stays a plain account (code size 0), or a plain Safe measured to fit. `DeployR1` prints
  its code size, and DEPLOY.md's R1 step 7 checks it.
- Question: should that be enforced on chain (for example by `setRecipient`), or is the operational rule enough?

**Q28. The owner can force the skip** on a token whose transfer cost they can push above the budget (a tax token that
swaps back on transfer).
- Status: decided (2026-10-02): accepted; the ERC-20 budget stays at 100,000 gas.
- Why: it bounds platform revenue only, and a larger budget would cost every owner more gas.

**Q9 (part 1), V11. A recipient that reverts, or is blocklisted, blocks new locks, schedules and subscriptions**
until the FeeController owner calls `setRecipient`. Existing vaults and wallets are unaffected.
- Status: by design.
- Why: `setRecipient` is the recovery lever, which is why `FeeController.renounceOwnership` is disabled.

**N1. The recipient and share copied into a position vault can never change.** If the recipient's key is lost, or
the recipient is moved, every existing position vault keeps paying the old address (a plain account that has lost its
key is never skipped, since it accepts value).
- Status: by design. It is the price of "a later fee change never touches an existing lock".
- Question: do you see a safer shape that keeps that promise?

**Q10. The LP fee has no caller-side maximum**, while the flat fee must be sent exactly.
- Status: decided, no change.
- Why: it is bounded by its 100 bps cap and the 48-hour notice on increases. A `maxFeeBps` argument would change the
  ABI.

**T5. A zero fee** (`PRO_MONTHLY`, `VEST_FLAT`, `LOCK_FLAT`) lets anyone extend Pro time or pad registries for
free.
- Status: by design; tested (`test_aZeroPrice_subscribesForFree`, `test_flatFee_canBeZero_ifTheRecipientCanStillReceive`).
- Why: the FeeController owner simply must not set one.

### D. Position managers and pools

**Q8, Q24. The manager allow-list is the root of trust for position locks.** A hostile allow-listed manager can
create fake position vaults, choose their registry keys (they come from its `currencies()`), and lie about everything
the vault asks it. `setManager` can flip an allowed manager's `kind`, for new locks only.
- Status: by design.
- Why: only the Uniswap managers are ever allow-listed (testnet: v4 only), and the VaultFactory owner is meant to be a
  Safe before mainnet.

**Q21. v4 hooks would run on the zero-liquidity decrease.** A hook could revert (blocking `collect`; `withdraw` still
works) or take fees through return deltas.
- Status: fixed (decided 2026-10-02: reject hooked pools at the lock).
- Now: `lockPosition` reverts `HookedPool` when a v4 position's PoolKey has a non-zero `hooks` address, checked after
  the NFT arrives, with the principal checks (`VaultFactory.sol` lines 163 and 266-270). A pool's hooks are part of
  its PoolKey and never change. v3 positions are unaffected.
- Tests: `vault/PositionFactory.t.sol` `test_lockPosition_v4_refusesAPoolWithHooks_andLeavesNothing` (ERC-20 and
  native pools) and `testFuzz_lockPosition_v4_refusesEveryHookAddress`; on the deployed PoolManager,
  `fork/PositionVault.fork.t.sol` `test_lockPosition_refusesAV4PositionInAPoolWithHooks`, with a hook that the
  PoolManager calls on `beforeAddLiquidity`.
- Question: an allow-listed manager is trusted to report the PoolKey truthfully (Q8, Q24). Is there a v4 pool whose
  hook could matter that the zero check misses?

**Q22. Anyone can add liquidity to a locked v3 position** (the manager's `increaseLiquidity` is open). The added
liquidity then stays locked.
- Status: by design. It harms only whoever adds it.

**Q23. On the real v4 PositionManager, a zero-liquidity INCREASE also settles fees**, like the DECREASE the vault
uses.
- Status: decided. DECREASE by zero is Uniswap's documented way to collect.
- Why: a reviewer found nothing exploitable. The strict mock pins the 0x01 byte, the fork suite checks 0x01 and 0x11
  on the deployed manager, and mutants 0x03 and 0x0e fail there.

**Q29. A position with no principal.** Before the fix, `lockPosition` accepted a v4 position with zero liquidity, or a
v3 position whose principal had been decreased into `tokensOwed` (released at the first collect as "fees").
- Status: fixed.
- Now: `lockPosition` reverts `NoLiquidity` for zero liquidity, `OwedNotCollected` when a v3 position has anything
  owed, and `PositionNotReceived` when the manager's `ownerOf` isn't the vault after the transfer.
  The checks are `VaultFactory.sol` lines 252-264. `PositionVault.liquidity()` exposes the live liquidity
  (`PositionVault.sol` lines 116-119). Unit and fork tests
  cover each case.

**Q32. Griefing a v3 lock by front-running.** Anyone can `increaseLiquidity` on another's v3 position just before
it is locked. That pokes the position, so accrued fees land in `tokensOwed`, and `lockPosition` then reverts
`OwedNotCollected`.
- Status: decided for testnet; to be revisited before mainnet.
- Why: it is v3 only and griefing only. It costs the attacker a swap fee, a deposit that stays with the victim, and
  gas. The Vault app shows `OwedNotCollected` as "collect fees, then lock" and chains the two.
- A possible fix: collect owed amounts to the depositor during the lock. That needs its own review.

**Q30. A huge donation could overflow the share arithmetic** and brick `collect`.
- Status: fixed. The share is computed with `Math.mulDiv` (`PositionVault.sol` line 203), with a test above 1.16e73
  units.

### E. Ownership and admin

**Q7, V2. `renounceOwnership` is disabled on `VaultFactory` and on each `ArcVesting` wallet.**
- Status: fixed (decided 2026-10-02). Both override it to revert `RenounceDisabled` for the owner, as `FeeController`
  does; a stranger still gets `OwnableUnauthorizedAccount`. Ownership still moves (two steps on the factory, one on a
  wallet).
- Why: on the factory, renouncing would freeze the allow-list for good, so a manager could never be added or
  disallowed again. On a wallet it would leave no one to pay: later releases would revert, or burn the tokens for a
  token that accepts the zero address.
- Tests: `vault/VaultFactory.t.sol` `test_renounceOwnership_alwaysReverts_ownerUnchanged_setManagerStillWorks`,
  `test_renounceOwnership_byAStranger_isUnauthorized`, `test_renounceOwnership_staysDisabled_afterOwnershipMoves`;
  `vesting/ArcVesting.t.sol` `test_renounceOwnership_alwaysReverts_releasesStillPayTheOwner`,
  `test_onlyTheOwnerCanTransferTheWallet`.

**Q14, V1. Ownership moves**, so a lock or a vesting wallet can be sold. A vault's transfer takes two steps. A
wallet's takes one step (OpenZeppelin's `Ownable`), unvested tokens included.
- Status: by design.
- Why: proofs read `owner()`, never the creator.

**Q17. `acceptOwnership` would pass for `address(0)`** when nothing is pending, if that address could send.
- Status: by design; the same as OpenZeppelin's `Ownable2Step`.

**D0. One full contract per schedule.** The original design said "one clone per schedule". `VestingFactory` deploys a full
`ArcVesting` instead (about 700,000 gas).
- Status: decided (2026-10-02): one full contract per schedule stays.
- Why: OpenZeppelin's `VestingWallet` keeps start, duration and cliff in immutables, which an EIP-1167 clone can't
  carry. A clone would need the upgradeable variant.
- A reviewer found the full contract isolates more strongly: no shared implementation, no delegatecall, no
  initializer.

### F. Assets that can't leave

**Q12, Q27, T4. Some assets can't be recovered, by design.** These are:
- tokens other than a vault's own asset;
- other NFTs (a position vault refuses them in `onERC721Received`);
- native value forced in with `selfdestruct`;
- tokens sent to a factory or an implementation;
- native dust below 1e12 wei in a vesting wallet;
- pool-currency leftovers in a position vault after `withdraw`, since `collect` needs the position. The owner should
  `collect` just before withdrawing (`PositionVault.sol` lines 141-143).

`withdraw(to)` also accepts the token contract or the vault itself as `to`.
- Status: by design. There is no rescue function: any rescue path is a way out for principal.

**Q31. Native value in v4 vaults.** Any v4 vault accepts native value in `receive`. `_split(address(0))` sweeps the
vault's whole native balance, so in a native pool a donation is split like a fee. In a v4 ERC-20/ERC-20 vault, native
value that arrives is stranded.
- Status: by design for now.
- Alternative: store whether the pool uses the native currency at `initialize` and refuse otherwise.

**Q13, Q15. Lock times.**
- Q13: a lock can't be shortened, even by mistake (the app confirms far dates); `extend` can be repeated.
- Q15: the minimum lock is one second; there is no floor.
- Status: by design; no floor decided.

### G. USDC's two views on Arc

**Q16, Q25, V14, T1. Behaviour of `0x3600` that no local test can reach.** A fork can't move `0x3600` balances, so
these are open:
- whether its `transfer` fits the 100,000-gas share budget (Q25);
- whether an ERC-20 transfer of USDC to a contract whose `receive` reverts succeeds (T1). The `ArcVesting` wallet
  refuses native value, so this matters for vesting USDC;
- how Arc's blocklist behaves.

Also, a v4 pool of native USDC against `0x3600` would split both currencies under `address(0)`.
- Status: open until testnet. DEPLOY.md's R1 step 7 settles T1 with a 1 USDC schedule after the deployment; the rest
  goes to the live read-only suite. Only a mock covers the two views today.

**V5, and the vesting double release.** OpenZeppelin keeps separate books for native value and each token. On Arc,
USDC vested through its ERC-20 view is also the wallet's native balance, so a beneficiary could release the same
asset twice.
- Status: fixed (deviation D1, then review I1).
- `receive` reverts, `release()` reverts, and `releasable()` and the native `vestedAmount(uint64)` return zero
  (`ArcVesting.sol` lines 43-68). Native value that arrives anyway is released through `release(token)` in its ERC-20
  view (`test_usdcsTwoViews_cannotBeReleasedTwice`).

**Q26, T2. Blocklisting.**
- An owner who can't receive native value, or who is blocklisted by a pool token, can't `collect` until ownership
  moves.
- A blocklisted vesting wallet freezes its tokens.
- A blocklisted beneficiary can still transfer the wallet.
- Status: by design.

### H. Vesting bounds

**V8. Chosen bounds.**
- `start` may be in the past, or up to 3650 days ahead.
- `duration` runs from 1 second to 3650 days, and `cliff <= duration`.
- `amount <= type(uint256).max / 3650 days` (`MAX_AMOUNT`), which keeps OpenZeppelin's `total * elapsed` from
  overflowing.

These close every overflow and panic path for the amount funded at creation (deviations D5, D6). They are the
implementer's choices; are they reasonable?

`MAX_AMOUNT` bounds only the funded amount. Later deposits, or a positive rebase, can push the total past it, and
releases between the cliff and the end then revert on overflow until `end()`. This is in NatSpec
(`ArcVesting.sol` lines 26-31).

### I. ProPass

**V9. `subscribe` accepts `account == address(0)`.**
- Status: **owner decision, open**; the current behaviour is kept. It is only the payer's loss.
- Question: should it revert?

**V10. `ProPass` has no reentrancy guard.** It writes `paidUntil` before forwarding the payment, and a re-entry can
only buy more time with more exact payments.
- Status: by design.

### J. The deployment script

**Q11, V12, V13. The order of deployment.** Each constructor probes its fee keys, so `DeployR1` adds the keys first,
then deploys. It runs every check before its first transaction:
- the sender owns the FeeController;
- each key is missing, or (in continue mode) present with the exact fee and cap and no pending change;
- a reused contract is of the right kind, wired to this FeeController, and (for VaultFactory) owned by the sender.

`@arcos/chain`'s `FEE_KEYS` lists the R1 keys.
- Status: fixed and tested (`test/DeployR1.t.sol`, 26 tests).
- Question: can a contract with a fallback that answers every selector get through the continue-mode checks? A
  reviewer judged that the owner and FeeController checks that follow stop it.

## What we most want checked

1. That no sequence of calls moves a vault's principal before `unlockAt`, or to anyone but the owner. This includes
   through the managers and through a hostile token, recipient or hook.
2. `PositionVault._tryPayPlatform`: the gas bound, the 32-byte return copy, and the success rule. Can the owner or
   the recipient turn it against the other?
3. The v4 encoding in `_collectV4`, against Arc's deployed PositionManager.
4. `ArcVesting` on Arc's two-view USDC.
5. The decisions above: the two still open (Q20, V9), and those made on 2026-10-02 (Q9, Q28, D0, the Q21 fix and
   the `renounceOwnership` fix under Q7 and V2). What you would choose, and why.
