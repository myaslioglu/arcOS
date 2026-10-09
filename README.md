# 4rc.OS

4rc.OS is a desktop-style web app for Circle's Arc network. It lets you inspect a token's
contract, mint one without writing code, send a token to many wallets in one flow, swap and
bridge, and revoke token approvals. A Terminal reads the chain and opens apps from typed
commands, and a Roadmap window lists the apps still on the way.

Automated analysis, not investment advice.

## Apps

| App | What it does | Status |
| --- | --- | --- |
| Finder | Your token holdings and self-created tokens, as files you can drag onto other apps | Live |
| Inspector | Reads a token's contract and reports what it can do to holders | Live |
| Mint | Creates a fixed-supply, mintable or burnable token | Live |
| Drop | Sends a token to many wallets in one or more transactions | Live |
| Swap | USDC, EURC and cirBTC | Live |
| Bridge | Move USDC to and from Arc | Live |
| Wallet | Connect, switch network, disconnect | Live |
| About | What 4rc.OS is, read from inside the app | Live |
| Terminal | Opens apps and reads the chain from typed commands; it never signs or sends anything | Live |
| Revoke | Lists a wallet's live token approvals and revokes one with a transaction the wallet confirms | Live |
| Radar | Lists new tokens as the index records them, each with Inspector's checks | Live |
| Watchdog | Alerts when a token you hold changes | Live |
| Vault | Lock liquidity and team tokens | Coming soon |
| Vesting | Release tokens on a schedule | Coming soon |
| Meme | Soon | Coming soon |

Mint and Drop call `TokenFactory` and `Multisend`, which are deployed on Arc mainnet and Arc Testnet
(addresses in `packages/contracts/DEPLOY.md`). Swap and
Bridge run on Circle's App Kit SDK in keyless mode (no Circle API key ships to the browser) and
charge a 0.20% platform fee, split 90/10 between `NEXT_PUBLIC_FEE_RECIPIENT` and Circle, when that
address is set — with it unset, both apps still work and simply charge no fee. Installing App Kit
requires one dependency exception (a transitive `toml` advisory forced to a patched major via an
npm `overrides` entry); see [SECURITY.md](./SECURITY.md#dependency-exceptions) for exactly what,
why, and the condition for removing it.

## Run it

Needs Node 22 (22.22.2 or later) and **npm 11 or newer** (`npm -v`). npm 10 installs Foundry but leaves out the
`forge`, `cast` and `anvil` commands, so the `npx forge` / `npx cast` commands in
[DEPLOY.md](packages/contracts/DEPLOY.md) would offer to download unrelated npm packages with those
names instead; `npm install -g npm@11` fixes it.

```
npm install
npm run dev
```

Open http://localhost:3000. The app runs against Arc testnet by default.

To point it at mainnet, set `NEXT_PUBLIC_ARC_NETWORK=mainnet` in `apps/web/.env.local` (copy from
`apps/web/.env.example`). https://4rcos.com runs on mainnet.

Phones with no browser wallet can connect through WalletConnect when `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` (a public Reown
project ID) is set; `apps/web/apphosting.yaml` sets it for https://4rcos.com.

Arc mainnet's public explorer answers browsers but refuses requests from servers. The Inspector
window runs in your browser, so it isn't affected. The pages the server builds (the
`/t/<address>` report, its preview image, `/badge` and `/api/inspect`) read the same explorer data
from Blockscout's PRO API when `BLOCKSCOUT_API_KEY` is set. It's a server-only variable, never
`NEXT_PUBLIC_`; on App Hosting it's a Secret Manager secret. Without it, the explorer-backed checks
on those pages (source verification, holder concentration) read "unknown", except that a token made
by 4rc.OS's own TokenFactory still passes source verification through the factory (see below).
Revoke's list (`/api/approvals`) reads approval events through the same key; without one it asks the
public explorer, which refuses the server on mainnet, so the list answers "Couldn't load approvals" there.

Sign-in with Ethereum (`/api/auth/*`) needs two server settings: `NEXT_PUBLIC_SITE_URL`, whose host is the only domain a
sign-in message may name, and `ARCOS_SESSION_SECRET`, 32 random bytes or more that sign the session cookie (on App
Hosting a Secret Manager secret). It also reads and writes the Firestore database `arcos`. Without either setting the
rest of the site runs as before and sign-in answers "Sign-in isn't available right now." There is no default secret.

Other scripts, run from the repo root: `npm test`, `npm run typecheck`, `npm run lint`, `npm run
build`. `npm run test:live -w @arcos/inspector` is not part of `npm test`: it reads real Uniswap v4
and Aerodrome pools from Arc mainnet's public RPC (read-only, one call at a time), so it needs the
network; behind an HTTP proxy, set `NODE_USE_ENV_PROXY=1` in the shell first. `npm run
test:emulator -w @arcos/data` runs the Firestore suite against the local emulator; it needs Java 21
or newer and no credentials. It and `@arcos/data`'s unit tests use the pinned Firebase CLI in
`tools/firebase`, which the root install leaves out: install it once with
`npm ci --ignore-scripts --prefix tools/firebase`.

The end-to-end smoke suite (`e2e/`, Playwright in Chromium) runs against a production build: `NEXT_PUBLIC_ARC_NETWORK=mainnet npm run build` (CI builds with
the settings in `apps/web/apphosting.yaml`), then `npm run test:e2e`, which starts `next start` on port 3100 and stops it
afterwards. Outside CI it reuses a server already listening on 3100, so stop any `next dev` there first. It needs the browser once
(`npx playwright install chromium`), or `E2E_CHROMIUM_PATH` set to a Chromium you already have. The `/t/<address>` and
`/badge/<address>` cases read the chain when they run and still pass when that read fails. `npm run typecheck:e2e` checks
the suite's types; `npm run lint` covers it too.

## Repo layout

- `apps/web` — the Next.js app: the desktop shell wiring, the apps listed above, the public
  proof page (`/t/<address>`), badge (`/badge/<address>`) and API routes, including `/api/pulse`
  (the wallpaper's live chart), `/api/approvals` (Revoke's list), `/api/event` (the event counts),
  `/api/pools/<token>` (a token's indexed pools), `/api/radar` (Radar's first page of a filter) and
  `/api/csp-report` (content security policy violation reports).
- `packages/shell` — the desktop itself: windows, dock, folders and trays, launcher, drag and
  drop. `src/core` is pure TypeScript (no React beyond type imports), `src/ui` holds the React
  components and `src/styles` the CSS. No wagmi or viem imports.
- `packages/chain` — chain facts and USDC math: network config, contract addresses, unit
  conversions.
- `packages/inspector` — the token inspection engine. No React or Next imports, so it can run on
  the server and in the browser. It also holds the server plumbing the site and the functions
  share: the RPC transport with its cooldowns, the explorer request wrapper and the deadline.
- `packages/data` — the Firestore layer for the named database `arcos`: collection names, document
  types, id helpers and converters (the pure entry, `@arcos/data`, which never imports
  firebase-admin), and `arcosDb()` (the server-only entry, `@arcos/data/server`).
- `functions` — the scheduled functions (codebase `arcos`): `arcosIndexer` records new USDC and
  EURC pools and their tokens, inspects them and keeps Radar's first pages. Bundled with esbuild
  into `functions/deploy`.
- `packages/contracts` — the three Solidity contracts and their Foundry tests, scripts and
  deployment guide.
- `docs/QA-R0.md` — the manual test script for this release.
- `docs/DEPLOYING.md` — how a change reaches https://4rcos.com: CI, the deploy and its smoke checks.
- `docs/OPERATIONS.md` — what runs where, the indexer's console controls, deploying the functions, costs and checks.

## Contracts

`FeeController`, `TokenFactory` and `Multisend` are not upgradeable and hold no funds between
transactions — every paid call forwards its fee to the fee recipient in the same transaction.

Current fees on mainnet: Mint 1 USDC flat; Drop 0.05 USDC per recipient, 2 USDC minimum, charged per
recipient submitted including any that fail. Each fee is hard-capped on chain at deployment and can
never be raised past that cap: Mint's cap is 50 USDC; Drop's per-recipient cap is 0.5 USDC, and its
minimum's cap is 10 USDC. A fee decrease takes effect immediately; an increase only takes effect 48
hours after it's scheduled, so a fee can never change on you without warning. `Multisend` accepts
at most 400 recipients per transaction, sized to Arc's 30,000,000 block gas limit; the app itself
batches at 200 per transaction to leave headroom.

`FeeController`'s ownership can be transferred but never renounced — it's the only recovery lever
if the fee recipient ever stops accepting value. That's a real, single point of failure worth
naming plainly: every paid action (Mint, Drop) forwards its fee to one fee-recipient address in the
same transaction and reverts the whole action if that transfer fails, so if that address ever
becomes unable to receive value — a contract with no `receive()`, or one blocklisted on Arc — every
paid action starts reverting until the owner points `FeeController` at a working address with
`setRecipient`. This is a risk to the ACTION (it stops working until fixed), not to your funds:
these contracts hold no funds between transactions, so nothing here is ever at risk of being lost.

The contracts are deployed on Arc mainnet and Arc Testnet, and none have been audited. See
`packages/contracts/DEPLOY.md` for the addresses, how deployment works and what it needs from
whoever runs it.

## How Inspector decides things

Inspector runs nine checks against a token's contract: source verification, ownership,
privileged functions (mint, blacklist, fee, limit, pause), proxy upgradeability, holder
concentration, liquidity, liquidity lock, reliance on `PREVRANDAO`, and a simulated buy and sell
(check 10; a vesting check 9 is still to come). It reports "N of 9 checks
pass" plus an evidence link per finding — never a numeric score — and, whenever some checks
couldn't be resolved, says so explicitly ("5 of 9 checks pass · 4 couldn't be checked") rather than
folding an unknown into either a pass or a fail. A missing or unreadable owner never turns a
privileged function into a "can't be called" pass: if the contract has no `owner()`/`getOwner()`
but does have privileged functions, both the ownership and privileges findings read "unknown", not
"pass" — the same rule that applies to any other failed or missing read.

## What Inspector can and can't see

- It follows standard proxies one hop: EIP-1967 implementation and beacon slots, the older
  ZeppelinOS implementation and admin slots (Circle's FiatToken proxies, EURC among them), and
  EIP-1167 clones. A proxy behind a proxy, or one whose slots disagree, reads "unknown", not "clean".
- Anything upgradeable never earns a pass about control. With the code replaceable, "no privileged
  functions" and "ownership is renounced" describe only the logic running now, so they are shown as
  warnings naming whoever can replace it.
- "Nothing found" counts only when the scan can be shown to have read the contract's functions. A
  non-standard dispatcher (Vyper, Huff, fallback-only), custom proxy storage, a diamond (EIP-2535)
  or a `DELEGATECALL` to code it can't identify all read "unknown" rather than clean.
- What makes a selector scan count as complete is seeing ERC-20 `transfer` in the bytecode (or in a
  verified ABI). A contract that shows `transfer` and routes its other functions through a jump
  table could still hide one from the scan.
- A token that uses `DELEGATECALL` at all — including to its own address, as OpenZeppelin's
  `Multicall` does, or to a linked library — reads "unknown" rather than clean, and a clone of a
  clone is not followed.
- Privileged functions are recognised by selector and by verified-ABI name; one whose name and
  signature appear in neither list isn't detected.
- A Uniswap v4 pool counts as liquid when the v4 quoter can pay out 1,000 units of the quote
  currency, USDC or EURC, from it, each quote within a gas limit of its own. It counts as thin only
  when the quoter says the pool itself hasn't enough liquidity; a quote that fails any other way reads
  "unknown". A pool with a hook reads "unknown" too: the hook runs inside the swap, so it could make
  a quote say either, and the trade simulation's few USDC say nothing about 1,000. Next to that,
  Inspector shows what is "in range": what the pool's active liquidity holds between the current
  price and the edge of its current tick range. That is an exact figure for that range and no more,
  so it is often far less than what the pool can pay out. A Uniswap v2, v3 or Aerodrome pool counts
  as liquid from 1,000 units of USDC or EURC in the pool.
- The trade check (check 10) buys the token with 10 USDC, or 0.1% of the pool's depth when that is
  less (never under 0.01 USDC), and sells everything straight back into the same pool: first in every
  USDC pool discovery found liquid, then in every USDC pool without a hook that it didn't but where
  the token could still trade (a v2 pair with tokens in its reserves, a v3 or Aerodrome pool holding
  any USDC, any hookless v4 pool that exists, such as a single-sided launch pool with nothing in range
  and a quote that can't pay), up to six pools in all. A liquid decoy pool that lets sells through
  doesn't stand in for a thinner pool: the thinner one gets its own round trip, and what it shows
  counts. In a v2 pair that pays nothing for the test amount (a dust raw reserve, or a token whose one
  raw unit is worth more), the buy is what buys one raw unit, up to the larger of 20 USDC and 2% of
  the pair's USDC reserve, and never over 1,000 USDC (the override funds it, so it costs nothing); a
  pair where one unit costs more isn't tried, but it still counts as a pool left untried, which caps
  a pass. Each round trip is one `eth_call`: a small simulator contract
  (`packages/contracts/src/sim/TradeSimulator.sol`) is placed with a state override at a fresh random address S, together with the USDC it spends and
  the gas the call prepays at the network's current gas price, and a second copy of it at another
  fresh random address R acts as the router. It swaps against the pool contracts directly. The buy
  pays the pool with a plain `transfer`; the sell moves the token as a real sell does, with S
  approving R and R calling `transferFrom` into the pool. The round trips run in parallel, each with
  fresh S and R. The gas price read and every round trip must end before the inspection's own
  deadline (15 seconds on the site's server and in the indexer), less a second kept for the rest of
  the report, or within 8 seconds where there is none (in the browser); a pool whose round trip takes
  longer reads "unknown". Nothing is signed or sent. When no hookless pool can be tried, a single
  round trip runs in the deepest USDC pool it can trade against, hooked or not.
- Liquid means what the liquidity check means: 1,000 USDC in a v2 pair's reserves next to some tokens
  and a nonzero quote for its test amount, 1,000 USDC in a v3 or Aerodrome pool, or a v4 quote that
  paid out 1,000 USDC (a hooked v4 pool is never found liquid; its liquidity is undecided). A v2 pair
  with no tokens in its reserves (USDC sent to it and `sync`ed) is never traded against, and never
  counts as a deeper pool. For ordering and comparing, a hookless v4 pool found liquid counts as at
  least 1,000 USDC, since its depth is only what is in range at the current price; EURC is compared
  1:1 with USDC.
- How each round trip is judged: a buy the pool paid out for and of which no tokens arrived is a fail
  ("Buying delivers no tokens"). A sell that reverts after the buy went through is a fail ("Can't be
  sold") in a Uniswap v2 pair or a hookless v4 pool, where only the token can refuse it. A Uniswap v3
  or Aerodrome pool checks it was paid in full, so it refuses a token that arrives short (a transfer
  tax), and a v4 pool's hook can refuse a swap. When the sell reverts in one of those, Inspector runs
  a second round trip in the deepest liquid Uniswap v2 or hookless v4 USDC pool whose depth covers
  the test amount of the pool that refused the sell. Only a sell there that goes through and brings
  USDC back turns that pool's fail into a warning, which names both pools ("Selling into its deepest
  pool (Uniswap v3 0x…) reverted; selling into the Uniswap v2 pair (0x…) went through"); so does an
  RPC that won't run that second round trip. Everything else keeps the fail, with a note on what the
  second round trip came to: no such pool, a buy there that reverts or gets nothing, a sell there that
  reverts too or brings nothing back, a buy there that delivers no tokens, tokens the pool there would
  give nothing back for, or a round trip that runs out of gas (which shows nothing either way). A
  round trip that loses more than the pool's own fees for the two swaps plus 3% is a warning; where
  the fee can change from swap to swap (a dynamic-fee or hooked v4 pool, Aerodrome) the line is 5%. A
  round trip that brings nothing back loses 100% and is a warning too. A buy that reverts, takes no
  USDC or gets nothing from the pool, a leg that runs out of the gas it is given, and an RPC that won't
  run the simulation (or read the gas price, or answer in time) read "unknown" for that pool.
- The finding is the worst of the round trips, naming the pool. A pool is left out only when it
  couldn't trade on its own account, which nothing the token does can bring about: before sending
  anything the simulator checks the pool's own state (a v2 pair whose reserves give nothing for the
  amount; a v3, Aerodrome or v4 pool with no price, or its price already at the swap's limit) and
  reports "pool can't trade", or the pool took no USDC and paid nothing out. So a dust pool can't cost
  an honest token its pass. A pool that took USDC and paid nothing out does count: a token with few
  decimals can make a small buy round to nothing. Before buying in a v3, Aerodrome or v4 pool, the
  simulator raises the buy, at the pool's price, to what buys about 100 raw units of the token when
  the test amount would buy fewer, up to the larger of 20 USDC and 2% of the pool's USDC and never
  over 1,000 USDC; when even two units cost more, the pool isn't bought in and counts as "unknown".
  An honest token with few decimals whose buy is capped at that limit gets only a few whole units, so
  rounding alone can show a loss and give a warning; this errs on the safe side.
  Everything else counts, in any pool: a buy that reverts (the token may refuse a buyer it can tell is
  simulated, one with code, say) reads "unknown" and caps a pass, and a sell blocked after a buy went
  through fails the token. A pool left out is no measurement: when it is deeper than a pool measured,
  it caps a pass as an untried deeper pool does. Any fail is a fail. Otherwise the worst warning, or
  the largest loss, is shown, and the result is a pass only when every round trip counted passed, one
  of them in a liquid pool, and nothing below applies; each of these caps it at a warning, named in
  the finding:
  - a pool counted whose round trip read "unknown" (a buy the token may have refused or undone in a
    liquid pool, say, by rejecting a recipient with code or refunding the USDC);
  - more pools to try than the six tried ("7 pools; 6 were tried");
  - no liquid pool among those counted: the round trips were measured on thin pools ("Measured on a
    thin pool");
  - any other pool the scan found that is liquid or of undecided liquidity and wasn't traded
    against: a hooked v4 pool, a pool against EURC;
  - a pool deeper than a pool measured that wasn't traded against.
  Only when every pool counted read "unknown" is the result "unknown". The cost: an honest token
  gets a warning when it has a hooked or EURC pool next to its USDC pools, more than six pools to try,
  only thin pools, or when someone donates USDC to a pool with no liquidity (a v3 pool never
  initialized, say), which then reads as liquid and can't trade. That errs on the safe side, and a
  donation costs whoever sends it.
- A pass says what the simulated buys and sells did at that block, in the pools measured; a rule the
  owner can switch on later, or one that applies to larger amounts, isn't covered. A token can still
  tell the simulation from a real trade, and one written to behave differently for it can pass (see
  Known limits for the ways it can).
- Holder figures are only as complete as the explorer's index, and exclude burn addresses, known
  pools (Uniswap v4's PoolManager among them) and lock contracts. A list the explorer won't confirm
  is complete gives a floor, not a concentration.
- The name and symbol are chosen by whoever deployed the contract and can imitate another token.
- A token made by this network's 4rc.OS TokenFactory passes source verification through the factory:
  `isArcosToken(token)` is on-chain evidence that its code is one of the factory's four fixed
  templates, whose source is part of the factory's verified source. Its own explorer page can still say
  it isn't verified. This never applies to code that forwards its calls.

## Known limits

- The mainnet block explorer's API answers non-browser clients with a Cloudflare challenge, so a
  server-side inspection (the proof page, the badge) can resolve fewer checks there than the same
  inspection run in a browser tab.
- Liquidity checks read Uniswap v2, v3 and v4 and Aerodrome pools against USDC and EURC (testnet has
  Uniswap v4 only). A v4 pool is found by probing the standard hookless pool keys, at fees of 0.01%,
  0.05%, 0.25%, 0.3% and 1% against USDC, EURC and native USDC, so a pool with a hook or an unusual
  fee can be missed until an index lists it.
- Drop approves exactly the total a run needs, but a run that stops early (a refused signature, an
  unconfirmed batch) leaves the unspent part of that allowance with the Multisend contract until a
  later run uses it or you revoke it in Revoke.
- Revoke lists ERC-20 allowances, single NFTs' approvals, operators (ERC-721 and ERC-1155
  `setApprovalForAll`) and Permit2 allowances. "Revoke all" sends one transaction per approval, one
  after another, and every Permit2 pair in a single `lockdown`; it stops at the first one that fails.
- Revoke's list reads at most 5 pages of 1,000 Approval logs, 2 pages of ApprovalForAll logs and 2
  pages of Permit2's logs (three explorer requests for most wallets), and considers at most 500
  approvals of every kind together, the most recent first; a wallet with more history than that may
  not see its oldest approvals. Hiding a pair just revoked lasts for that browser tab (kept in sessionStorage) until a
  newer approval of the same pair appears; a new tab, or that tab's storage cleared, reads the chain
  again from scratch.
- Radar lists the newest 50 tokens the indexer has recorded on Arc mainnet for each filter, with no
  older pages yet, and can trail the chain by a few minutes. A token shows its checks once the
  indexer has inspected it. The testnet site has no token index, so its Radar says so.
- The trade check sees each pool as it is at that block. A pool whose price is parked at its limit
  while the inspection runs reads "pool can't trade" and is left out (when it is the deepest, it caps
  as a deeper pool not measured); a token whose real market is a pool moved there for the moment of
  the inspection, and back after, can pass on its other pools.
- A Uniswap v3 or Aerodrome pool's depth is still read from its USDC balance, which anyone can raise
  by sending it USDC, so a pool with no liquidity can read as liquid. Its round trip then can't trade
  and reads "unknown", which caps an honest token's pass at a warning.
- The trade check never trades against a hooked v4 pool (unless the token has no pool without one),
  nor against a pool whose quote isn't USDC (EURC): the override can fund only USDC, and a hook runs
  inside the swap. Those pools only count for the caps above: one that is liquid or undecided, or
  deeper than a pool measured, makes a pass a warning.
- Pools the scan never finds neither trade nor cap: pools against other quote tokens than USDC and
  EURC, pools on other DEXes, and hooked or unusual-fee v4 pools no index lists. A token whose real
  market is in such a pool can still pass on the pool Inspector did find. Hooked v4 pools reach the
  scan only through the pool index; when the index can't be read (the site gives it 1.5 seconds), the
  inspection runs without them, so a hooked pool that would have capped a pass doesn't.
- A v2 pair whose one raw token unit costs more than its limit (20 USDC, or 2% of its USDC reserve, up
  to 1,000 USDC) isn't traded against. It counts as a pool left untried, so the token can't pass, but
  a sell it would block there isn't shown as a fail.
- Inspector's trade simulation (check 10) can still be told from a real trade. S and R are fresh
  random addresses and the call carries the network's gas price, but: `tx.origin` (S) has code, which
  a wallet's address doesn't; S and R are addresses the token has never seen, and R is no router it
  knows, so a token that lets only known routers or wallets it has recorded sell can tell them apart;
  the buy and the sell happen in one transaction, at one block and timestamp; and the sell is made
  from a contract. A token can use any of these to pass the simulation and still trap real sellers. The other way round, a cooldown
  between a buy and a sell, a rule against selling in the block of the buy, or an anti-bot rule
  against contract callers reverts the simulated sell although a later sell from a wallet might go
  through; the finding then says "Selling straight back, in the same transaction and from a contract,
  reverted" rather than that no sell can ever succeed.
- Liquidity lock detection only reads Uniswap v2 LP token balances. Positions in v3, v4 and Aerodrome
  pools can't be read without an index yet, so a token with only those pools reads "unknown" for it,
  and so does a burned v2 pair next to a deeper v3 or Aerodrome pool or a v4 pool that may hold more.
- A token's name and symbol are chosen by whoever deployed it and can imitate another token's;
  Inspector doesn't yet detect a lookalike (homoglyph) name — always check the address, not just
  the name.
- Bridge offers EVM chains only (Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche, and their
  testnets) — no Solana in R0, since that needs a second, non-EVM wallet adapter this app doesn't
  have. BNB Smart Chain is listed greyed out: Circle doesn't issue USDC there (its CCTP domain is
  USYC only), so App Kit can't bridge to or from it. Bridge shows the source/burn/mint steps App
  Kit's settled result reports; it doesn't yet show live per-step progress while a transfer is still
  in flight, since App Kit's `kit.bridge()` call only resolves once the transfer settles rather than
  streaming per-step events.
- Swap and Bridge call Circle's App Kit SDK without an API key (keyless mode — see above), which
  means every user of this deployment shares one public rate limit with the rest of the internet,
  not a limit scoped to this app. A "busy" error from the service (shown as "The swap/bridge
  service is busy. Try again in a minute.") is possible, especially around a shared limit getting
  hit by unrelated traffic, and isn't a sign anything here is broken.
- The contracts are unaudited.

## Event counts

The site counts a few of its own events (an inspection, a mint, a drop, a swap, a bridge, a revoke, the name of a Terminal
command) so its maker can see what is used. The page sends each one's name and a few small values to `/api/event`, which
writes one line to the host's logs. There are no cookies and no third-party script, and the line holds no address, IP
address or user agent and nothing typed past a command's name. It says how often something happens, not who did it. The
details are in [SECURITY.md](./SECURITY.md#event-counts).

## Security

See [SECURITY.md](./SECURITY.md) for how to report a vulnerability.

## Acknowledgments

Built with help from [Claude](https://www.anthropic.com/claude), Anthropic's AI assistant.

## License

MIT — see [LICENSE](./LICENSE).

WalletConnect is pinned at `@walletconnect/ethereum-provider` 2.21.8, the last release under Apache-2.0. Later releases of
WalletConnect's packages (2.21.9 on) and of `@reown/appkit` (1.8.3 on) moved to Reown's own community licence, which is
not an open-source one. `scripts/walletconnect-licence.mjs` runs with the web tests and fails if `package-lock.json` ever
resolves a WalletConnect package at 2.21.9 or later, an `@reown/*` package at 1.8.0 or later (a margin below 1.8.3, to be
safe), or a package of either scope under a licence that isn't permissive.
