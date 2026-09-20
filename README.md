# ARC.os

ARC.os is a desktop-style web app for Circle's Arc network. It lets you inspect a token's
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
| About | What ARC.os is, read from inside the app | Live |
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
Fees are capped on-chain at deployment (Mint 15 USDC flat; Drop 0.05 USDC per recipient, 2 USDC
minimum, charged per recipient submitted including any that fail) and a fee increase only takes
effect 48 hours after it's scheduled, so it's never a surprise. `Multisend` accepts at most 400
recipients per transaction, sized to Arc's 30,000,000 block gas limit; the app itself batches at
200 per transaction to leave headroom. `FeeController`'s ownership can be transferred but never
renounced — it's the only recovery lever if the fee recipient ever stops accepting value.

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

## Known limits

- The mainnet block explorer's API answers non-browser clients with a Cloudflare challenge, so a
  server-side inspection (the proof page, the badge) can resolve fewer checks there than the same
  inspection run in a browser tab.
- Liquidity and lock checks cover Uniswap v2 and v3 pools against USDC and EURC only. Uniswap v4
  and Aerodrome aren't scanned yet.
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
