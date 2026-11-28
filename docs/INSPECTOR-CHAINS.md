# Inspector on other chains

What the Inspector reads on Ethereum, Base, Arbitrum One and OP Mainnet, how each check decides there, and what was
measured to set it up. Arc is unchanged: its rules are in the [README](../README.md#how-inspector-decides-things). The
settings and the owner's steps are in [DEPLOYING.md](DEPLOYING.md#the-inspectors-other-chains), and what it costs is in
[OPERATIONS.md](OPERATIONS.md#the-inspectors-other-chains).

## Switching a chain on

- `NEXT_PUBLIC_INSPECT_CHAINS` names the chains switched on, by slug, separated by commas: `ethereum`, `base`,
  `arbitrum`, `optimism`. Unset or empty, none is. Arc is always on and needs no entry. The testnet site never reads
  another chain, whatever the value.
- A chain switched on has `/t/<slug>/<address>` (with its social card), `/badge/<slug>/<address>` and
  `/api/inspect/<slug>/<address>`. Any other slug, a chain that is switched off, and every chain on the testnet site
  answer 404; the API's body is `{ "error": "Not available on this network." }`.
- Arc keeps its links. `/t/<address>`, `/badge/<address>` and `/api/inspect/<address>` are Arc's for good, and
  `/t/arc/<address>`, `/badge/arc/<address>` and `/api/inspect/arc/<address>` redirect to them permanently (308).
- Switch on one chain at a time. Watch the provider's dashboard and the explorer budget for a few days before the next.

## Where the reads go

Every inspection on these chains runs on the site's server (`apps/web/src/lib/inspect-server.ts`). The browser never
reads these chains for the Inspector, so no key reaches it.

| | Ethereum | Base | Arbitrum One | OP Mainnet |
|---|---|---|---|---|
| Chain id | 1 | 8453 | 42161 | 10 |
| RPC, with `INSPECT_RPC_KEY` | `eth-mainnet.g.alchemy.com` | `base-mainnet.g.alchemy.com` | `arb-mainnet.g.alchemy.com` | `opt-mainnet.g.alchemy.com` |
| RPC fallback (public) | `ethereum-rpc.publicnode.com` | `mainnet.base.org` | `arb1.arbitrum.io/rpc` | `mainnet.optimism.io` |
| Explorer data | Blockscout PRO API, `api.blockscout.com/1` | `api.blockscout.com/8453` | `api.blockscout.com/42161` | `api.blockscout.com/10` |
| Evidence links | `eth.blockscout.com` | `base.blockscout.com` | `arbitrum.blockscout.com` | `optimism.blockscout.com` |
| Also linked (never evidence) | Etherscan | Basescan | Arbiscan | Optimistic Etherscan |
| Second source for verification | Sourcify | Sourcify | Sourcify | Sourcify |

- **RPC.** The provider first, then the public RPC (`apps/web/src/lib/rpc-urls.ts`). The key goes in the
  `Authorization: Bearer` header, never in the URL: viem writes the URL into its error messages. An endpoint that fails
  (a timeout, an HTTP error, a wrong key's 401) is skipped for 60 seconds by every call in that server instance, and
  the next one is asked. Without the key (or with the value `none`) only the public RPC is read.
- **Explorer.** Blockscout's PRO API, with the site's `BLOCKSCOUT_API_KEY`, while the day's explorer budget lasts
  ([OPERATIONS.md](OPERATIONS.md#the-inspectors-other-chains)). Without the key, past the budget, or with a budget of 0
  (switched off), the explorer isn't asked: holder concentration reads "couldn't check", and so does source verification
  unless Sourcify has a match. The report says why ("The explorer wasn't asked: ..."), and so do the proof page, the
  badge's title and the social card.
- **Sourcify.** `sourcify.dev/server/v2/contract/<chain id>/<address>`, free and keyless, 5 seconds a request: one for
  the token, and one for the code a proxy runs.
- **Cache and limits.** A report is kept 5 minutes in each server instance (30 seconds when degraded), keyed by chain and
  address, so Arc's report of an address is never Base's. In each instance, a client gets 30 `/api/inspect` calls a
  minute, every chain and Arc together, and another 30 a minute for `/t` (with its card) and `/badge` on these chains
  together. Arc's `/t` and `/badge` have no limit, as before. At most 4 uncached inspections of these chains run at once
  in an instance, the four chains together; the next one answers "busy". Arc keeps its own 8, as before, and
  inspections of these chains never take one of them.

## How each check decides

| Check | What runs | Reads "couldn't check" when |
|---|---|---|
| Source verification | Blockscout and Sourcify. Either one saying verified is a pass; a proxy needs the code it runs verified too, by either. | Neither says verified. Both saying "not verified" is no fail here: Etherscan isn't read, and many contracts are verified there only. Also when one says no and the other can't answer, and for an Arbitrum Stylus program with a proxy slot that is set or can't be read, since the code it runs may be elsewhere. |
| Ownership, privileges, proxy | As on Arc. | As on Arc (logic that can't be read, `DELEGATECALL` to code that can't be identified), and always for an EIP-7702 delegated account or an Arbitrum Stylus program, whose code isn't EVM bytecode to scan, but for a Stylus program's proxy check when one of its proxy slots is set: that is a fail, as for any upgradeable proxy. Behind a proxy or a clone, on Arc too, such code is logic that can't be read, and a clone of it is never "not upgradeable". |
| Holder concentration | Blockscout's holder list, leaving out the token, burn addresses, every pool the scan found (any quote, any venue, the classic pools included) and Uniswap v4's PoolManager. A pool the scan can't see counts as a holder, so over half is a fail only when the holders with no code hold over half on their own, and a warning otherwise. | The explorer wasn't asked or didn't answer; fewer than ten rows it doesn't confirm are all; the pool scan failed. |
| Liquidity | Pools against USDC and USDT (counted 1:1 with the dollar) on Uniswap v2, v3 and hookless v4, Slipstream, and the classic pools by balance. Pools against WETH and native ETH are found and named, never priced. | Only pools against WETH or ETH were found; no pool or only thin ones were found, since each chain has pools the scan can't see (below). |
| Liquidity lock | Uniswap v2 LP tokens, read as on Arc, but never a pass or a fail here. | Always. A pair whose LP is at least 95% burned may sit beside a deeper pool the scan can't see (each chain has some, below), however deep the pair is, so it is no pass; LP that isn't burned may sit in a lock contract, and none is recognized on these chains yet, so it is no fail. Also when a pair against WETH sits beside one against USDC, since which holds more can't be told. |
| PREVRANDAO | The opcode scan, with each chain's wording (below). | The logic can't be read. |
| Trade | Pools against USDC only, funded by a state override of USDC's balance at storage slot 9. Pools against USDT, WETH or ETH, hooked v4 pools and classic pools are never traded through, but a liquid or undecided one keeps a pass to a warning. | No USDC pool; the RPC won't run the simulation. |

Uniswap v4 positions aren't read on these chains: the position index is Arc's. Nor is anything the indexer adds on Arc
(hooked v4 pools from the index, Radar, Watchdog).

## Each chain

| | Ethereum | Base | Arbitrum One | OP Mainnet |
|---|---|---|---|---|
| Quote tokens | USDC, USDT, WETH; ETH in v4 | USDC, WETH; ETH in v4 | USDC, USDT, WETH; ETH in v4 | USDC, USDT, WETH; ETH in v4 |
| Uniswap | v2, v3 (four fee tiers), hookless v4 | v2, v3, hookless v4 | v2, v3, hookless v4 | v2, v3, hookless v4 |
| Slipstream | | Aerodrome Slipstream | | Velodrome Slipstream |
| Classic pools | | Aerodrome classic | | Velodrome classic |
| Not read | hooked or unusual-fee v4 pools; other DEXes | the same, and Slipstream pools of other factories | hooked or unusual-fee v4 pools; other DEXes | the same as Base |
| PREVRANDAO warning | "Uses PREVRANDAO, which validators can bias" | "Uses PREVRANDAO, predictable on Base" | "Uses PREVRANDAO, always 1 on Arbitrum" | "Uses PREVRANDAO, predictable on OP Mainnet" |
| Out of gas reads as | -32003 "out of gas..." (geth) | -32003 (op-geth) | -32000 "out of gas..." (Nitro) | -32003 (op-geth) |

A v4 pool is found by probing the standard hookless keys at fees of 0.01%, 0.05%, 0.25%, 0.3% and 1%, against every
quote token and native ETH, as on Arc. Bridged stablecoins (USDC.e, USDbC) aren't quote tokens, and Base's entry has no
USDT. Arbitrum's USDT calls itself "USD₮0" on chain; the Inspector names it USDT. The PREVRANDAO wording is sourced: EIP-4399's security
considerations for Ethereum, Arbitrum's "Solidity support" page (`block.prevrandao` returns the constant 1), and the OP
Stack's "Differences" page for Base and OP Mainnet (L1's RANDAO value at the L1 origin block, known before the L2 block).

## Measurements, 2026-11-27

All read-only: `eth_call`, `eth_getCode`, `eth_getStorageAt`, `eth_blockNumber`, `eth_gasPrice`, and GET requests to
Sourcify and the public Blockscout instances. No transaction, no wallet. The live suite (`npm run test:live -w
@arcos/inspector -- chains`) repeats most of it; the rest came from one-off scripts of the same calls.

### The pinned addresses

Every address in the registry (`packages/chain/src/inspect-chains.ts`) holds code, and each was cross-read against the
others, through Alchemy at Ethereum block 26,509,284, Base 63,125,439, Arbitrum One 528,117,804 and OP Mainnet
160,108,344, and again through each public RPC the same day. Code sizes are in bytes.

| Chain | Contract | Address | Code | Cross-read |
|---|---|---|---|---|
| Ethereum | USDC | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | 2,186 | `symbol()` USDC, `decimals()` 6 |
| Ethereum | USDT | `0xdAC17F958D2ee523a2206206994597C13D831ec7` | 11,075 | USDT, 6 |
| Ethereum | WETH | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` | 3,124 | WETH, 18 |
| Ethereum | Uniswap v2 factory | `0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f` | 13,859 | `getPair(USDC, WETH)` is `0xB4e1…C9Dc`, whose `factory()` is this one |
| Ethereum | Uniswap v3 factory | `0x1F98431c8aD98523631AE4a59f267346ea31F984` | 24,535 | `getPool(USDC, WETH, fee)` at all four tiers names a pool whose `factory()` is this one |
| Ethereum | v4 PoolManager | `0x000000000004444c5dc75cB358380D2e3dE08A90` | 24,009 | |
| Ethereum | v4 PositionManager | `0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e` | 23,877 | `poolManager()` is the PoolManager |
| Ethereum | v4 StateView | `0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227` | 3,531 | the same |
| Ethereum | V4Quoter | `0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203` | 5,820 | the same |
| Base | USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | 1,852 | USDC, 6 |
| Base | WETH | `0x4200000000000000000000000000000000000006` | 2,041 | WETH, 18 |
| Base | Uniswap v2 factory | `0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6` | 13,859 | `getPair(USDC, WETH)` is `0x88A4…bB9C`, its own |
| Base | Uniswap v3 factory | `0x33128a8fC17869897dcE68Ed026d694621f6FDfD` | 24,535 | all four tiers, its own |
| Base | v4 PoolManager | `0x498581fF718922c3f8e6A244956aF099B2652b2b` | 24,009 | |
| Base | v4 PositionManager | `0x7C5f5A4bBd8fD63184577525326123B519429bDc` | 23,877 | `poolManager()` is the PoolManager |
| Base | v4 StateView | `0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71` | 3,531 | the same |
| Base | V4Quoter | `0x0d5e0F971ED27FBfF6c2837bf31316121532048D` | 5,820 | the same |
| Base | Aerodrome Slipstream factory | `0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A` | 4,958 | `tickSpacings()` [1, 50, 100, 200, 2000, 10]; `getPool(USDC, WETH, s)` at 1, 50, 100 and 200 names a pool whose `factory()` is this one |
| Base | Slipstream position manager | `0x827922686190790b37229fd06084350E74485b72` | 24,542 | `factory()` is the factory |
| Base | Aerodrome classic factory | `0x420DD381b31aEf6683db6B902084cB0FFECe40Da` | 3,516 | `getPool(USDC, WETH, false)` and `(…, true)` name pools whose `factory()` is this one and which `isPool` accepts |
| Arbitrum One | USDC | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | 1,852 | USDC, 6 |
| Arbitrum One | USDT | `0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9` | 2,141 | USD₮0, 6 |
| Arbitrum One | WETH | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` | 2,092 | WETH, 18 |
| Arbitrum One | Uniswap v2 factory | `0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9` | 13,859 | `getPair(USDC, WETH)` is `0xF64D…366a`, its own |
| Arbitrum One | Uniswap v3 factory | `0x1F98431c8aD98523631AE4a59f267346ea31F984` | 24,535 | all four tiers, its own |
| Arbitrum One | v4 PoolManager | `0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32` | 24,009 | |
| Arbitrum One | v4 PositionManager | `0xd88F38F930b7952f2DB2432Cb002E7abbF3dD869` | 23,877 | `poolManager()` is the PoolManager |
| Arbitrum One | v4 StateView | `0x76Fd297e2D437cd7f76d50F01AfE6160f86e9990` | 3,531 | the same |
| Arbitrum One | V4Quoter | `0x3972C00f7ed4885e145823eb7C655375d275A1C5` | 5,820 | the same |
| OP Mainnet | USDC | `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` | 1,852 | USDC, 6 |
| OP Mainnet | USDT | `0x94b008aA00579c1307B0EF2c499aD98a8ce58e58` | 6,774 | USDT, 6 |
| OP Mainnet | WETH | `0x4200000000000000000000000000000000000006` | 2,041 | WETH, 18 |
| OP Mainnet | Uniswap v2 factory | `0x0c3c1c532F1e39EdF36BE9Fe0bE1410313E074Bf` | 13,859 | `getPair(USDC, WETH)` is `0x4C43…7815`, its own |
| OP Mainnet | Uniswap v3 factory | `0x1F98431c8aD98523631AE4a59f267346ea31F984` | 24,535 | all four tiers, its own |
| OP Mainnet | v4 PoolManager | `0x9a13F98Cb987694C9F086b1F5eB990EeA8264Ec3` | 24,009 | |
| OP Mainnet | v4 PositionManager | `0x3C3Ea4B57a46241e54610e5f022E5c45859A1017` | 23,877 | `poolManager()` is the PoolManager |
| OP Mainnet | v4 StateView | `0xc18a3169788F4F75A170290584ECA6395C75Ecdb` | 3,531 | the same |
| OP Mainnet | V4Quoter | `0x1f3131A13296FB91C90870043742C3CDBFF1A8d7` | 5,820 | the same |
| OP Mainnet | Velodrome Slipstream factory | `0xCc0bDDB707055e04e497aB22a59c2aF4391cd12F` | 4,958 | `tickSpacings()` [1, 50, 100, 200, 2000, 10]; `getPool(USDC, WETH, s)` at 1 and 100 names a pool whose `factory()` is this one (50 and 200: no pool) |
| OP Mainnet | Slipstream position manager | `0x416b433906b1B72FA758e166e239c43d68dC6F29` | 24,542 | `factory()` is the factory |
| OP Mainnet | Velodrome classic factory | `0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a` | 4,358 | both USDC/WETH pools, its own, `isPool` true |

Multicall3 (`0xcA11bde05977b3631167028862bE2a173976CA11`, 3,808 bytes) is at the same address on all four. The Uniswap v4
contracts have the same code size on every chain.

**Slipstream's second factories.** On Base and OP Mainnet a second factory of the same code serves other Slipstream
pools: Base `0xaDe65c38CD4849aDBA595a4323a8C7DdfE89716a` (2,318 pools), OP Mainnet
`0x548118C7E0B865C2CfA94D15EC86B666468ac758` (51 pools). Whose they are wasn't confirmed, so their pools aren't read,
and both chains name "Slipstream pools from other factories" among what Inspector doesn't read.

### Out of gas, and a call refused before it runs

An `eth_call` of an endless loop (`0x5b600056`, placed by a state override) capped at 100,000 gas. The trade check reads
a chain's own answer as the node's: a token that burns its gas costs that one round trip, and no endpoint cools down.

| Chain | Through Alchemy | Through the public RPC |
|---|---|---|
| Ethereum | -32003 `out of gas: gas required exceeds: 100000` | the same (publicnode) |
| Base | -32003 `out of gas: gas required exceeds: 100000` | the same |
| Arbitrum One | -32000 `out of gas: gas required exceeds: 100000` | -32000 `out of gas` |
| OP Mainnet | -32003 `out of gas: gas required exceeds: 100000` | the same |

The same call with 20,000 gas, under the 21,000 a call costs before it runs, answers -32000 `intrinsic gas too low`
everywhere but `arb1.arbitrum.io`, which says `err: intrinsic gas too low: have 20000, want 21000 (supplied gas 20000)`.
Neither is read as out of gas. The Inspector never sends a call that low.

### State overrides and USDC's balance slot

All eight endpoints ran an `eth_call` with a code override (it returned 42) and with a `stateDiff` override. Writing an
amount at keccak256(abi.encode(S, 9)) in USDC's storage made `balanceOf(S)` answer that amount on all four chains,
through Alchemy and through the public RPC; without the override it answered 0. So the trade check funds its simulator
the same way on each.

### Gas price and base fee

The simulation prepays its gas at the call's gas price, and a node may refuse a price under the block's base fee. Read
on 2026-11-27:

| Chain | `eth_gasPrice` (wei) | Latest base fee (wei) |
|---|---|---|
| Ethereum | 42,572,445 | 42,567,151 |
| Base | 6,000,000 | 5,000,000 |
| Arbitrum One | 20,000,000 (Alchemy), 20,074,000 (public); earlier that day 20,000,000 | 20,000,000; earlier that day 20,020,000 |
| OP Mainnet | 1,007,594 | 7,594 |

Arbitrum's node once quoted a price under the base fee, so off Arc the call pays the node's price and a quarter
(`funding` in `packages/inspector/src/simulate.ts`).

### A round trip through a USDC/WETH pool

The trade simulator bought WETH with 10 USDC and sold it straight back, in the first Uniswap v3 USDC pool the trade
check tried:

| Chain | Pool | Fee | Back | Lost |
|---|---|---|---|---|
| Ethereum | `0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8` | 0.3% | 9.940090 USDC | 0.60%, the two swaps' fees |
| Base | `0x6c561B446416E1A00E8E93E221854d6eA4171372` | 0.3% | 9.940090 USDC | 0.60% |
| Arbitrum One | `0xC6962004f452bE9203591991D15f6b388e09E8D0` | 0.05% | 9.990002 USDC | 0.10% |
| OP Mainnet | `0xc1738D90E2E26C35784A0d3E3d8A9f795074bcA4` | 0.3% | 9.940090 USDC | 0.60% |

### Sourcify

`GET /server/v2/contract/<chain id>/<address>`:

- verified: 200 with `runtimeMatch` `match` or `exact_match` (USDC on all four; Uniswap v2's Ethereum factory);
- no match: 404 with `match`, `creationMatch` and `runtimeMatch` all `null` (an address with no code; an unknown chain
  id gives the same);
- a malformed address: 400 with `customCode: invalid_parameter`.

The Inspector counts `match` and `exact_match` as verified, a 404 as "no match", and anything else as no answer.

### Blockscout

- The PRO API without a key answers 402: `{"error":"Proceed with API key or make a X402 payment to continue"}`. The
  server never asks it without one, and a 402 with the key (the plan's quota or payment gone) spends the rest of the
  day's budget at once.
- The public instances: `eth.blockscout.com` and `optimism.blockscout.com` answered the server (`smart-contracts`,
  `tokens` and `tokens/<address>/holders`, the same shapes as Arc's explorer); `eth.blockscout.com` answered 500 for
  USDC's contract record once that day and 200 later. `base.blockscout.com` and `arbitrum.blockscout.com` answered 403
  with a Cloudflare challenge page. So the server reads all four through the PRO API only, and the public instances are
  where the evidence links go.
- The PRO API itself wasn't measured: this setup had no key for it. It is the same API the server already reads for Arc
  mainnet, by chain id.

### Source verification: Blockscout beside Sourcify

The 60 ERC-20 tokens at the top of Blockscout's token list, on the two instances that answer servers:

| Chain | Both verified | Blockscout only | Sourcify only | Neither |
|---|---|---|---|---|
| Ethereum | 59 | 1 | 0 | 0 |
| OP Mainnet | 58 | 2 | 0 | 0 |

Every one of them is verified on Blockscout, so the sample says nothing about how often a "not verified" on both
would be wrong. Etherscan is where most sources are verified first, and measuring that needs an Etherscan key. Until
it is measured, both sources saying "not verified" reads "couldn't check" on these chains, never a fail.

### The public RPCs and the provider under load

| Endpoint | 40 `eth_call` at once | A JSON-RPC batch of 20 |
|---|---|---|
| `ethereum-rpc.publicnode.com` | all answered (258 ms) | answered |
| `mainnet.base.org` | all answered (173 ms) | answered |
| `arb1.arbitrum.io/rpc` | all answered (244 ms) | answered |
| `mainnet.optimism.io` | all answered (452 ms) | refused: 413, -32014 "To send batches over 10 items, consider using a dedicated API provider" |
| Alchemy, each chain | all answered (255 to 342 ms) | answered |

Alchemy also answered 120 `eth_call` at once on Base (2.2 s) and three bursts of 40 a second apart. The Inspector sends
no JSON-RPC batches (it groups reads in Multicall3 calls instead), so OP Mainnet's batch limit doesn't touch it. A public
RPC promises no capacity: these figures are one afternoon's. With no key, or a wrong one, Alchemy answers 401 with
-32600 `Must be authenticated!`, and the server moves on to the public RPC.

### What an inspection sends

Counted by the live suite, through Alchemy, one uncached inspection at a time, explorer left out:

| Chain | Token | RPC requests | Of which |
|---|---|---|---|
| Ethereum | USDC | 43 | 32 `eth_call`, 7 `eth_getStorageAt`, 3 `eth_getCode`, 1 `eth_blockNumber` |
| Ethereum | WETH | 53 | 41 `eth_call`, 6 simulations, 3 slots, 1 code, block number, gas price |
| Ethereum | PEPE | 54 | 42 `eth_call`, 6 simulations, 3 slots, 1 code, block number, gas price |
| Base | USDC | 41 | 30 `eth_call`, 7 slots, 3 code, block number |
| Base | WETH | 47 | 35 `eth_call`, 6 simulations, 3 slots, 1 code, block number, gas price |
| Base | DEGEN | 54 | 41 `eth_call`, 6 simulations, 3 slots, 2 code, block number, gas price |
| Arbitrum One | USDC | 43 | 32 `eth_call`, 7 slots, 3 code, block number |
| Arbitrum One | WETH | 56 | 39 `eth_call`, 6 simulations, 7 slots, 2 code, block number, gas price |
| Arbitrum One | ARB | 65 | 47 `eth_call`, 6 simulations, 7 slots, 3 code, block number, gas price |
| OP Mainnet | USDC | 52 | 41 `eth_call`, 7 slots, 3 code, block number |
| OP Mainnet | WETH | 53 | 41 `eth_call`, 6 simulations, 3 slots, 1 code, block number, gas price |
| OP Mainnet | OP | 69 | 56 `eth_call`, 6 simulations, 3 slots, 2 code, block number, gas price |

A simulation is one `eth_call` with a state override. With the explorer asked, an inspection adds 4 to 6 explorer
requests, and 1 or 2 to Sourcify.

### What the checks said

The same run (tokens chosen on 2026-11-27: each chain's USDC and WETH, and PEPE `0x6982508145454Ce325dDbE47a25d4ec3d2311933`,
DEGEN `0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed`, ARB `0x912CE59144191C1204E64559FE8253a0e49E6548`, OP
`0x4200000000000000000000000000000000000042`). Through each public RPC, every status and every title came out the same;
only the depths moved.

| Chain | Token | Verified | Ownership | Privileges | Proxy | Holders | Liquidity | Lock | PREVRANDAO | Trade |
|---|---|---|---|---|---|---|---|---|---|---|
| Ethereum | USDC | pass | warn | fail | fail | unknown | pass | unknown | unknown | unknown |
| Ethereum | WETH | pass | pass | pass | pass | unknown | pass | unknown | pass | warn |
| Ethereum | PEPE | pass | pass | pass | pass | unknown | pass | unknown | pass | warn |
| Base | USDC | pass | warn | fail | fail | unknown | unknown | unknown | unknown | unknown |
| Base | WETH | pass | pass | pass | pass | unknown | pass | unknown | pass | warn |
| Base | DEGEN | pass | warn | warn | pass | unknown | unknown | unknown | pass | warn |
| Arbitrum One | USDC | pass | warn | fail | fail | unknown | pass | unknown | unknown | unknown |
| Arbitrum One | WETH | pass | warn | warn | fail | unknown | pass | unknown | warn | warn |
| Arbitrum One | ARB | pass | warn | fail | fail | unknown | pass | unknown | warn | warn |
| OP Mainnet | USDC | pass | warn | fail | fail | unknown | pass | unknown | unknown | unknown |
| OP Mainnet | WETH | pass | pass | pass | pass | unknown | pass | unknown | pass | warn |
| OP Mainnet | OP | pass | warn | fail | pass | unknown | pass | unknown | pass | warn |

What decided the unknowns and warnings:

- **Holders**: unknown everywhere, since the run left the explorer out (it had no PRO key).
- **Liquidity**: Base's USDC has pools against WETH and ETH only, so "Couldn't price the pools found". DEGEN has the same
  and a v4 pool whose quote didn't answer: "Couldn't verify the pools found". Elsewhere a USDC or USDT pool passes
  ("24,956,175 USDT of liquidity on Uniswap v3" for Ethereum's USDC).
- **Lock**: unknown everywhere. A token with v2 pairs against WETH and USDC can't be ranked ("This token has Uniswap v2
  pairs against USDT and WETH, and WETH isn't priced yet, so which one holds the most can't be told."), and LP that
  isn't burned can't fail where no lock contract is recognized ("100% of the v2 LP supply isn't burned or in a known lock
  contract, and the lock contracts on Base aren't recognized yet, so whether it can be withdrawn can't be told.").
- **PREVRANDAO**: unknown for the USDC proxies (`DELEGATECALL`). ARB's warning is the upgrade one ("Randomness can be
  added by an upgrade"). Arbitrum's WETH reads "Uses PREVRANDAO, always 1 on Arbitrum" because of two 0x44 bytes in the
  text of its error messages ("ECDSA: ", "EIP712Domain"), stored after the last instruction of its implementation's
  code: the scan reads the code as instructions from the first byte to the last (README, "Known limits").
- **Trade**: USDC can't trade against itself ("No USDC pool was found to trade against"). The others warn: more pools
  than the six tried ("10 pools; 6 were tried"), a liquid or undecided pool the check doesn't trade through (USDT, WETH,
  ETH, classic pools), a measurement on a thin pool, or a v4 buy that ran out of the gas it is given (PEPE: "A pool
  couldn't be measured"). Each round trip lost what the pool's fees come to.

## Measuring again

```sh
# Each chain through its public RPC:
npm run test:live -w @arcos/inspector -- chains
# Through Alchemy, the key read at a silent prompt (bash, Cloud Shell's shell), never typed into a command line, where
# shell history would keep it:
read -rsp 'Alchemy key: ' K; echo; INSPECT_RPC_KEY="$K" npm run test:live -w @arcos/inspector -- chains; unset K
# ...or from a file of your own outside the repository, readable by you alone (chmod 600):
INSPECT_RPC_KEY="$(cat ~/.inspect_rpc_key)" npm run test:live -w @arcos/inspector -- chains
# Any other endpoint, one chain at a time:
LIVE_RPC_BASE=https://... npm run test:live -w @arcos/inspector -- chains
```

The suite checks code at every pinned address, the cross-reads above, slot 9, each chain's out-of-gas answer, a WETH
round trip under 1%, Sourcify's answer for USDC and, with `BLOCKSCOUT_API_KEY` set, the PRO API by chain id. It prints
each inspection's findings and the requests it sent. Behind an HTTP proxy, set `NODE_USE_ENV_PROXY=1` first.
