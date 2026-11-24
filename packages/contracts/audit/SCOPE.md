# Audit scope: 4rc.OS R1 contracts

Status: **frozen** on 2026-11-24 (see "Commit"). The contracts, the deployment script and the tests are those of
`main` at `ddf1f5c`, the commit deployed on Arc Testnet on 2026-11-17, and none of them changed on `main` through
`a19ac2c`. The numbers below were measured on this code before the deployment and again at the freeze, with the same
results. They last changed with the owner's decision of 2026-11-16: `VestingFactory.tokenOf` records each wallet's
token, and `lockToken` and `lockPosition` take the highest share the caller accepts (`maxFeeBps`) and revert
`FeeAboveMax` above it. Before that they changed with the 2026-10-02 contract changes (hooked v4 pools refused at the
lock; `renounceOwnership` disabled on `VaultFactory` and `ArcVesting`).

The other documents in this folder:
- `THREAT-MODEL.md`: actors, assets, trust assumptions, and the open questions for the auditor.
- `INVARIANTS.md`: the properties the contracts must keep, and the test that enforces each.
- `slither.md`: a static-analysis run, with every finding triaged.

The product was called 4rc.OS when this package was written and is now ArcOS (https://4rcos.com). These documents keep
the old name in their titles, and the NatSpec of `VaultFactory`, `VestingFactory` and `FeeController` says ARC.os: all
three are the same product. The sources are left as deployed. Even a comment change alters the metadata hash at the end
of the bytecode, and the testnet comparison below would no longer hold.

## Commit

| | |
|---|---|
| Frozen code | `main` at `ddf1f5c` (`ddf1f5c5bf5a08164c2a13e4dee4b3bb9431322c`): `src/`, `script/`, `test/`, `foundry.toml`, `package.json` and the dependency pins in the root `package-lock.json`. It is the commit deployed on Arc Testnet on 2026-11-17 |
| Unchanged through | `main` at `a19ac2c` (`a19ac2c3a51c0c3aedc52d626843dab6835b663f`). At both commits the trees are `src` `1dcad9a`, `script` `7fe60cf`, `test` `8e5b756`, `foundry.toml` `1236e17` and `package.json` `4cbc2ae` (`git rev-parse <commit>:packages/contracts/src`, and so on), and the lockfile pins OpenZeppelin Contracts 5.6.1, forge-std 1.16.2 (`bf647bd`) and Foundry 1.7.1. Under `packages/contracts` only `DEPLOY.md` and `audit/SCOPE.md` changed in between; the root lockfile's changes are web packages only (Next.js 16.4.3 to 16.4.6) |
| Package documents | this folder and `DEPLOY.md` as of the freeze commit on `main`, the one that set the status above. It changes no code, so the frozen code can be read at that commit too |
| Draft written on | `main` at `5ad18ee` |
| Updated for the owner's decisions of 2026-10-02 | branch `audit-decisions`, from `main` at `8d91dd1` |
| Updated for the owner's decision of 2026-11-16 (`tokenOf`, `maxFeeBps`) | branch `r1-contract-changes`, contracts at `8db83fb`, from `main` at `aa4e1eb` |

The package is frozen at the contracts the testnet apps, Vault and Vesting, use on Arc Testnet: the deployment of
2026-11-17 from `ddf1f5c` (DEPLOY.md, "R1"). Inspector's lock and vesting checks come in a later release and are not a
condition of the freeze, because they need no contract change. The lock check will ask `VaultFactory.isVault` about a
token's top LP holders and about the `ownerOf` of known position NFTs, and the vesting check will read
`VestingFactory.isVesting` and `tokenOf`. All three are public mappings in the frozen code (`VaultFactory.sol` line 45,
`VestingFactory.sol` lines 30 and 35). A contract change from here on means a new testnet deployment, and the freeze
moves to that commit, with the comparison below made again.

Runtime bytecode on Arc Testnet matches `ddf1f5c`'s build, immutables masked: VaultFactory, VestingFactory, ProPass and
the two vault implementations. It was checked on 2026-11-17, and again for the freeze on 2026-11-24 at block
73,907,333. Outside the immutables the bytes are identical and the CBOR metadata hash is the same. The immutables hold
what the deployment wired: the testnet FeeController in all three contracts, and `lockVaultImpl` and
`positionVaultImpl` in VaultFactory. The method: `forge build` from `packages/contracts` (Foundry 1.7.1; solc 0.8.30,
whose sha256 matches the official release list), then each artifact's `deployedBytecode.object` against `eth_getCode`
from `https://rpc.testnet.arc.io`, with the byte ranges in the artifact's `deployedBytecode.immutableReferences` zeroed
in both.

## In-scope files

All paths are under `packages/contracts/`.

| File | Contracts | nSLOC | Lines | Role |
|---|---|---:|---:|---|
| `src/vault/LockVault.sol` | `LockVault` | 65 | 107 | One ERC-20 lock per clone: `extend`, `withdraw` after `unlockAt`, two-step ownership |
| `src/vault/PositionVault.sol` | `PositionVault` | 169 | 251 | One Uniswap v3 or v4 position NFT per clone: `collect` fees while locked, `withdraw` after `unlockAt` |
| `src/vault/VaultFactory.sol` | `VaultFactory` | 184 | 317 | Clones and funds vaults, takes the fees (never a share above the caller's `maxFeeBps`), keeps the registries, owns the position-manager allow-list, refuses v4 pools with hooks |
| `src/vault/interfaces/IPositionManagers.sol` | `IV3PositionManager`, `IV4PositionManager` | 17 | 54 | The manager calls the vaults make |
| `src/vesting/ArcVesting.sol` | `ArcVesting` | 26 | 69 | OpenZeppelin `VestingWalletCliff`, native path closed, renounce disabled |
| `src/vesting/VestingFactory.sol` | `VestingFactory` | 92 | 165 | Deploys and funds one wallet per schedule, takes the fee, keeps the registries and each wallet's token (`tokenOf`) |
| `src/ProPass.sol` | `ProPass` | 34 | 60 | Prepaid Pro time per account; forwards the payment |
| `src/FeeController.sol` | `FeeController` | 83 | 113 | Fee values, caps, 48-hour delay on increases, the fee recipient |
| `src/interfaces/IFeeController.sol` | `IFeeController` | 3 | 7 | What the fee payers read |
| `script/DeployR1.s.sol` | `DeployR1` | 155 | 204 | Adds R1's fee keys, deploys the three contracts, allow-lists the v4 PositionManager |
| **Total** | | **828** | **1,347** | Contracts alone (without the script): **673** nSLOC |

**How nSLOC was measured.** `solidity-code-metrics` 0.0.28, run from `packages/contracts`:

```sh
npx -y solidity-code-metrics src/vault/LockVault.sol src/vault/PositionVault.sol src/vault/VaultFactory.sol \
  src/vault/interfaces/IPositionManagers.sol src/vesting/ArcVesting.sol src/vesting/VestingFactory.sol \
  src/ProPass.sol src/FeeController.sol src/interfaces/IFeeController.sol script/DeployR1.s.sol
```

Its nSLOC counts normalised source lines: no blank lines and no comment lines (NatSpec included), with a statement
split over several lines counted as it is written. "Lines" is the file's physical line count. Both were measured again
at the freeze (2026-11-24, at `a19ac2c`) and are the same for every file.

### R0 contracts: which are in, and why

| Contract | In scope? | Why |
|---|---|---|
| `FeeController` | **In** | Every R1 contract reads its fee values and its recipient, and "a fee never exceeds its cap" (`INVARIANTS.md`) is enforced there. R1 does not deploy a new one: `DeployR1` adds five keys to R0's live controller, and each R1 contract holds it as an immutable. The controller is not upgradeable, so a finding in it is fixed by deploying a new controller and new R1 contracts wired to it. |
| `TokenFactory`, `src/tokens/*` | Out | R0, live on mainnet since 2026-09-25. No R1 contract calls them, R1 does not change them, and they hold no user asset beyond the transaction that creates a token. Can be quoted as an optional add-on. |
| `Multisend` | Out | R0, live on mainnet. Forwards value and tokens within one call and holds nothing after it; no R1 contract calls it; R1 does not change it. Optional add-on. |
| `script/DeployR0.s.sol` | Out | R0's deployment, already run. |

### Inherited code (context, not counted)

OpenZeppelin Contracts **5.6.1** (npm, pinned in `packages/contracts/package.json`). Audited upstream; in scope only
as the in-scope contracts use it:
- `proxy/Clones.sol` (EIP-1167 clones of `LockVault` and `PositionVault`);
- `proxy/utils/Initializable.sol` (the clones' `initialize`, disabled on the implementations);
- `utils/ReentrancyGuardTransient.sol` (needs TSTORE/TLOAD; see "Arc" below);
- `access/Ownable.sol`, `access/Ownable2Step.sol` (`VaultFactory`, `FeeController`);
- `finance/VestingWallet.sol`, `finance/VestingWalletCliff.sol` (`ArcVesting`: one-step `Ownable`, schedule in
  immutables);
- `token/ERC20/utils/SafeERC20.sol`, `utils/math/Math.sol` (`mulDiv`), `token/ERC721/IERC721Receiver.sol`.

The script uses `forge-std` v1.16.2 (`Script`, `console2`).

## External systems

These are not in scope. `THREAT-MODEL.md` says what the contracts trust each of them for.

| System | Address | Used by |
|---|---|---|
| Uniswap v3 `NonfungiblePositionManager` (Arc mainnet only; no code at this address on testnet) | `0x39654a85a4c05127f5fd6ed22caec077a0fb1377` | `PositionVault` with `Kind.V3`: `positions`, `collect`, `ownerOf`, `safeTransferFrom` |
| Uniswap v4 `PositionManager` (same address on both networks) | `0x6049c9a0e26405C0985f9E3685C87d0aE917f82B` | `PositionVault` with `Kind.V4`, for pools without hooks only: `modifyLiquidities` with `DECREASE_LIQUIDITY` (0x01) by zero and `TAKE_PAIR` (0x11), `getPoolAndPositionInfo`, `getPositionLiquidity`, `ownerOf`, `safeTransferFrom`. The action bytes were checked against the verified source of this deployment |
| Uniswap v4 `PoolManager` | `0x8366a39CC670B4001A1121B8F6A443A643e40951` | Reached only through the PositionManager |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Used by the v4 PositionManager to pull tokens when liquidity is added. The vaults never call it |
| USDC on Arc | native currency, and its ERC-20 view at `0x3600000000000000000000000000000000000000` | Fees are paid as native value (18 decimals). The ERC-20 view (6 decimals) is the same balance. A lock or schedule may hold USDC through the ERC-20 view; a v4 pool may use either form |

`VaultFactory` accepts position NFTs only from managers its owner has allow-listed (`setManager`). On testnet only the
v4 PositionManager is allow-listed (Uniswap v3 isn't deployed there). A mainnet deployment would add the v3 manager as
`Kind.V3`.

### Arc facts the contracts rely on

- Chain ids 5042 (mainnet) and 5042002 (testnet); blocks about every 0.5 s.
- TSTORE/TLOAD and MCOPY work on both networks. Checked with a read-only `eth_call` and a state override, so
  `ReentrancyGuardTransient` and the `cancun` target are safe.
- USDC is one balance with two views: native (18 decimals) and the ERC-20 at `0x3600...` (6 decimals). This is why
  `ArcVesting` closes the native path.
- A local fork cannot move `0x3600` balances: they live behind precompiles that forge's EVM lacks. So no fork test
  touches `0x3600`.

## Compiler and settings

From `foundry.toml` (`[profile.default]`):

| Setting | Value |
|---|---|
| solc | 0.8.30. Every in-scope file pins `pragma solidity 0.8.30;` |
| EVM version | `cancun` |
| Optimizer | on, 200 runs |
| via-IR | off (not set) |
| `bytecode_hash` | `ipfs` |
| Remappings | `@openzeppelin/contracts/=../../node_modules/@openzeppelin/contracts/`, `forge-std/=../../node_modules/forge-std/src/` |
| Foundry | 1.7.1 (npm `@foundry-rs/forge`), run through `scripts/forge.mjs`, which passes forge's exit code through |

Dependencies are installed with `npm ci` at the repository root.

## Deployed addresses

R1 is deployed on Arc Testnet (2026-11-17, from main at `ddf1f5c`; DEPLOY.md, "R1"). Mainnet comes after the audit.

| Network | Contract | Address |
|---|---|---|
| Arc Testnet (5042002) | `FeeController` (R0, reused) | `0xC470753e83c151a6A4A360869270291A6ED70d99` |
| Arc Testnet (5042002) | `VaultFactory` | `0x18A3c9ca7D7800a5dDA376bDFa4c0AA187675A23` |
| Arc Testnet (5042002) | `LockVault` implementation (`VaultFactory.lockVaultImpl()`) | `0x222d1c94eeb6f0F28c0B1B9D295164d818e4749e` |
| Arc Testnet (5042002) | `PositionVault` implementation (`VaultFactory.positionVaultImpl()`) | `0x0c487aEaEcC35Cf521ad970f605624A072afcDC0` |
| Arc Testnet (5042002) | `VestingFactory` | `0x1bDedA7EeA176d81c08DEA397058043124FE30d9` |
| Arc Testnet (5042002) | `ProPass` | `0x458e1e67c7ea1c7c12E7587E147fCD1e73d6f0F5` |
| Arc (5042) | `FeeController` (R0) | `0x2B37F9a9443B2DfaE6B7C7063586935a574B5699` |
| Arc (5042) | R1 contracts | none (after the audit) |

The fee keys `DeployR1` adds (flat fees are native USDC at 18 decimals, `_BPS` keys are basis points):

| Key | Fee | Cap | Read by |
|---|---|---|---|
| `LOCK_FLAT` | 30 USDC | 150 USDC | `VaultFactory`, per lock |
| `LOCK_LP_BPS` | 50 bps | 100 bps | `VaultFactory`, on a Uniswap-v2-shaped LP token lock |
| `LOCK_FEE_SHARE_BPS` | 200 bps | 500 bps | `VaultFactory`, copied into each position vault |
| `VEST_FLAT` | 20 USDC | 100 USDC | `VestingFactory`, per schedule |
| `PRO_MONTHLY` | 9 USDC | 29 USDC | `ProPass`, per month |

## Tests

Run from `packages/contracts`:

```sh
node scripts/forge.mjs test          # the default suite: unit, fuzz and invariant tests, no network
npm run test:fork                     # the fork suite: needs rpc.mainnet.arc.io
```

The default run took 122 s on four cores at the draft's base commit: 25 suites, 397 tests, all passing. With the
2026-10-02 changes it is 25 suites and 401 tests. At `main` `aa4e1eb` it is 27 suites and 449 tests (Inspector's trade
simulator and the vesting vectors the Vesting app shares came in between), and with the 2026-11-16 changes 27 suites
and 466 tests, all passing, in 83 s on four cores. At the freeze (2026-11-24, at `a19ac2c`, whose tests are the
frozen ones) it is the same 27 suites and 466 tests, all passing, in 90 s on four cores, with the per-suite counts
below. Fuzz tests run 512 times; the invariant suites set their own runs and depth (see `INVARIANTS.md`), with
`fail_on_revert` on.

| Suite | Tests | Covers |
|---|---:|---|
| `test/vault/LockVault.t.sol` | 26 | LockVault unit and fuzz |
| `test/vault/VaultFactory.t.sol` | 30 | lockToken, constructor probes, refusals, renounce disabled |
| `test/vault/VaultFees.t.sol` | 23 | flat and LP fees, the caller's maximum LP share (`maxFeeBps`), fee changes, blocked recipients |
| `test/vault/VaultTokens.t.sol` | 13 | fee-on-transfer, rebasing and hostile tokens |
| `test/vault/VaultRegistry.t.sol` | 14 | registries and slices |
| `test/vault/VaultFuzz.t.sol` | 4 | lock round trip, time bounds, who receives value |
| `test/vault/VaultGas.t.sol` | 8 | gas of each entry point |
| `test/vault/VaultInvariants.t.sol` | 9 | 8 invariants and a scripted handler run |
| `test/vault/PositionVault.t.sol` | 53 | PositionVault unit tests, the platform-share skip (`test_q9_*`) |
| `test/vault/PositionFactory.t.sol` | 21 | lockPosition, registries, principal checks, hooked v4 pools, the caller's maximum share |
| `test/vault/PositionFuzz.t.sol` | 3 | exact split, who receives value, extend |
| `test/vault/PositionInvariants.t.sol` | 8 | 7 invariants and a scripted handler run |
| `test/vesting/ArcVesting.t.sol` | 20 | the schedule, the closed native path, rebasing and taxed tokens, renounce disabled |
| `test/vesting/VestingFactory.t.sol` | 30 | createVesting, bounds, registries, `tokenOf` |
| `test/vesting/VestingFuzz.t.sol` | 6 | the curve against a reference, fees, slices |
| `test/vesting/VestingGas.t.sol` | 6 | gas |
| `test/vesting/VestingInvariants.t.sol` | 8 | 7 invariants and a scripted handler run |
| `test/vesting/VestingVectors.t.sol` | 2 | the curve against the vectors the Vesting app's tests share |
| `test/ProPass.t.sol` | 22 | ProPass unit, fuzz and gas |
| `test/FeeController.t.sol` | 14 | FeeController, including the cap fuzz test |
| `test/DeployR1.t.sol` | 26 | the script's keys, order, refusals and continue mode |
| **In scope** | **346** | The other 120 tests cover out-of-scope code: the R0 contracts and Inspector's trade simulator |

The fork suite, `test/fork/PositionVault.fork.t.sol` (27 tests), runs `PositionVault` and `VaultFactory` against the
real Uniswap v3 NonfungiblePositionManager and v4 PositionManager on a fork of Arc mainnet at block 23,450,000, with
mock-token pools (v3, v4 ERC-20/ERC-20, v4 native). It checks the fee split, every early exit on the vault and on both
managers, the refusal of a v4 pool with a live hook, the refusal of a share above the caller's `maxFeeBps` before the
position moves, and that the owner gets a working position back at `unlockAt`.
It is not part of the default run or of CI, because it needs the network. At the freeze its 27 tests passed with the
fork's state read live from `rpc.mainnet.arc.io` (`--no-storage-caching`, 2026-11-24). Test doubles live in
`test/vault/mocks/` and `test/vesting/mocks/`.

## Out of scope

- The R0 contracts above (`TokenFactory`, the token templates, `Multisend`, `DeployR0`).
- Aerodrome Slipstream positions. `Kind.V3` means Uniswap v3's manager only: Slipstream's `positions()` tuple differs,
  and its manager is not allow-listed.
- Uniswap v3 and v4 (core, periphery, hooks), Permit2, OpenZeppelin's internals, USDC and Arc's precompiles, and Arc's
  blocklist policy. Their behaviour enters the review only as assumptions (`THREAT-MODEL.md`).
- Off-chain code: the web apps, Inspector, the indexer, and `@arcos/chain` (ABIs and addresses). They read the
  contracts; the threat model says what they must not assume.
- Operations: the testnet and mainnet deployments themselves, moving ownership to a Safe, key management. `DEPLOY.md`
  is reference material.
- The level of the fees. Their caps and the 48-hour delay are in scope.
- The test code and mocks, which are there to be read, not reviewed.
