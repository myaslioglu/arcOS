# 4rcOS

4rcOS is a desktop-style web app for Circle's Arc network. It lets you inspect a token's
contract, mint one without writing code, and send a token to many wallets in one flow.

Automated analysis, not investment advice.

## Apps

| App | What it does | Status |
| --- | --- | --- |
| Finder | Your token holdings and self-created tokens, as files you can drag onto other apps | Live |
| Inspector | Reads a token's contract and reports what it can do to holders | Live |
| Mint | Creates a fixed-supply, mintable or burnable token | Needs deployed contracts |
| Drop | Sends a token to many wallets in one or more transactions | Needs deployed contracts |
| Swap | USDC, EURC and cirBTC | Live |
| Bridge | Move USDC to and from Arc | Live |
| Wallet | Connect, switch network, disconnect | Live |
| About | What 4rcOS is, read from inside the app | Live |
| Vault | Lock liquidity and team tokens | Coming soon |
| Vesting | Release tokens on a schedule | Coming soon |
| Watchdog | Alerts when a token you hold changes | Coming soon |
| Radar | New tokens and locks, scored | Coming soon |
| Revoke | Remove token approvals | Coming soon |
| Terminal | Do all of this by typing | Coming soon |

Mint and Drop call `TokenFactory` and `Multisend`, which are not deployed yet — both windows show
"isn't deployed on this network yet" until they are (see `packages/contracts/DEPLOY.md`). Swap and
Bridge run on Circle's App Kit SDK in keyless mode (no Circle API key ships to the browser) and
charge a 0.20% platform fee, split 90/10 between `NEXT_PUBLIC_FEE_RECIPIENT` and Circle, when that
address is set — with it unset, both apps still work and simply charge no fee. Installing App Kit
requires one dependency exception (a transitive `toml` advisory forced to a patched major via an
npm `overrides` entry); see [SECURITY.md](./SECURITY.md#dependency-exceptions) for exactly what,
why, and the condition for removing it.

## Run it

```
npm install
npm run dev
```

Open http://localhost:3000. The app runs against Arc testnet by default.

To point it at mainnet, set `NEXT_PUBLIC_ARC_NETWORK=mainnet` in `apps/web/.env.local` (copy from
`apps/web/.env.example`). Don't do this before `ARCOS.mainnet` in
`packages/chain/src/addresses.ts` has the real deployed addresses — until then, mainnet mode would
just show every contract-backed app as not deployed.

Other scripts, run from the repo root: `npm test`, `npm run typecheck`, `npm run lint`, `npm run
build`.

## Repo layout

- `apps/web` — the Next.js app: the desktop shell wiring, the apps listed above, the public
  proof page (`/t/<address>`), badge (`/badge/<address>`) and API routes.
- `packages/shell` — the desktop itself: windows, dock, trays, launcher, drag and drop. No wagmi
  or viem imports.
- `packages/chain` — chain facts and USDC math: network config, contract addresses, unit
  conversions.
- `packages/inspector` — the token inspection engine. No React or Next imports, so it can run on
  the server and in the browser.
- `packages/contracts` — the three Solidity contracts and their Foundry tests, scripts and
  deployment guide.
- `docs/QA-R0.md` — the manual test script for this release.

## Contracts

`FeeController`, `TokenFactory` and `Multisend` are not upgradeable and hold no funds between
transactions — every paid call forwards its fee to the fee recipient in the same transaction.

Current fees: Mint 15 USDC flat; Drop 0.05 USDC per recipient, 2 USDC minimum, charged per
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

None of the contracts are deployed yet, and none have been audited. See
`packages/contracts/DEPLOY.md` for how deployment works and what it needs from whoever runs it.

## How Inspector decides things

Inspector runs eight checks against a token's contract: source verification, ownership,
privileged functions (mint, blacklist, fee, limit, pause), proxy upgradeability, holder
concentration, liquidity, liquidity lock, and reliance on `PREVRANDAO`. It reports "N of 8 checks
pass" plus an evidence link per finding — never a numeric score — and, whenever some checks
couldn't be resolved, says so explicitly ("5 of 8 checks pass · 3 couldn't be checked") rather than
folding an unknown into either a pass or a fail. A missing or unreadable owner never turns a
privileged function into a "can't be called" pass: if the contract has no `owner()`/`getOwner()`
but does have privileged functions, both the ownership and privileges findings read "unknown", not
"pass" — the same rule that applies to any other failed or missing read.

## What Inspector can and can't see

- It follows standard proxies one hop: EIP-1967 implementation and beacon slots, and EIP-1167
  clones. A proxy behind a proxy, or one whose two slots disagree, reads "unknown", not "clean".
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
- Holder figures are only as complete as the explorer's index, and exclude burn addresses, known
  pools and lock contracts. A list the explorer won't confirm is complete gives a floor, not a
  concentration.
- The name and symbol are chosen by whoever deployed the contract and can imitate another token.

## Known limits

- The mainnet block explorer's API answers non-browser clients with a Cloudflare challenge, so a
  server-side inspection (the proof page, the badge) can resolve fewer checks there than the same
  inspection run in a browser tab.
- Liquidity and lock checks cover Uniswap v2 and v3 pools against USDC and EURC only. Uniswap v4
  and Aerodrome aren't scanned yet.
- Drop approves exactly the total a run needs, but a run that stops early (a refused signature, an
  unconfirmed batch) leaves the unspent part of that allowance with the Multisend contract until it
  is used by a later run or revoked by hand. A Revoke app arrives in R1.
- Liquidity lock detection only reads Uniswap v2 LP token balances; a v3 position's lock needs an
  indexer, which arrives with Radar.
- A token's name and symbol are chosen by whoever deployed it and can imitate another token's;
  Inspector doesn't yet detect a lookalike (homoglyph) name — always check the address, not just
  the name.
- Bridge offers EVM chains only (Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche, and their
  testnets) — no Solana in R0, since that needs a second, non-EVM wallet adapter this app doesn't
  have. Bridge shows the source/burn/mint steps App Kit's settled result reports; it doesn't yet
  show live per-step progress while a transfer is still in flight, since App Kit's `kit.bridge()`
  call only resolves once the transfer settles rather than streaming per-step events.
- Swap and Bridge call Circle's App Kit SDK without an API key (keyless mode — see above), which
  means every user of this deployment shares one public rate limit with the rest of the internet,
  not a limit scoped to this app. A "busy" error from the service (shown as "The swap/bridge
  service is busy. Try again in a minute.") is possible, especially around a shared limit getting
  hit by unrelated traffic, and isn't a sign anything here is broken.
- The contracts are unaudited.

## Security

See [SECURITY.md](./SECURITY.md) for how to report a vulnerability.

## License

MIT — see [LICENSE](./LICENSE).
