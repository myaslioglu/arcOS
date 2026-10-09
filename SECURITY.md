# Security policy

## Scope

This covers the code in this repository:

- The three Solidity contracts in `packages/contracts` (`FeeController`, `TokenFactory`,
  `Multisend`), deployed or not.
- The web app in `apps/web`, including its API routes.

Third-party dependencies (Next.js, wagmi, viem, OpenZeppelin, and the rest) are out of scope —
report those upstream.

## Reporting a vulnerability

Open the repository's Security tab and choose "Report a vulnerability". That opens a private
advisory only the maintainers can see. Please don't open a public issue for a security problem.
Include a description of the issue, the steps to reproduce it, its impact, and a contract address
and network if the issue is on-chain.

Don't test a finding against mainnet contracts or real funds beyond what's needed to demonstrate
it.

There's no bounty program at this time.

## What to expect

An acknowledgement within a few business days, and a report back once the issue is understood or
fixed. Coordinated disclosure — please give us time to address a report before making it public.

## Where the site runs

https://4rcos.com runs on Firebase App Hosting (Cloud Run, behind Google's load balancers), configured in
`apps/web/apphosting.yaml`. It has three server secrets: `BLOCKSCOUT_API_KEY` (the key for Blockscout's PRO API, which
the server's explorer reads use because explorer.arc.io refuses server requests), `ARCOS_SESSION_SECRET` (the key of
the sign-in cookie, below) and `TELEGRAM_WEBHOOK_SECRET` (what Telegram sends in the `X-Telegram-Bot-Api-Secret-Token`
header of each call to `/api/telegram/webhook`, which the route compares in constant time). All three are Secret Manager
secrets, pinned to a version and available at runtime only. None is ever a `NEXT_PUBLIC_` value or in the repository.
Every other
setting in that file is public: `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`, for one, is a client identifier that ships in
the browser bundle.

## Sign-in with Ethereum

Signing in is free and sends no transaction: the wallet signs an EIP-4361 message (`apps/web/src/lib/siwe.ts`,
`apps/web/src/lib/auth-server.ts`).

- **Nonce.** `GET /api/auth/nonce` makes 16 random bytes with the server's CSPRNG and stores them in the Firestore
  database `arcos` for 10 minutes. A nonce is accepted once: it is read and deleted in the same transaction that signs
  the wallet in, and its expiry is checked in code as well as by the TTL policy. It is bound to the browser that
  fetched it: the same answer sets `__Host-arcos_nonce` (`HttpOnly; Secure; SameSite=Lax; Path=/`, 10 minutes) to the
  nonce's SHA-256, and verify refuses a message whose nonce doesn't match that cookie (compared in constant time),
  then clears it.
- **Message.** It must be exactly the canonical EIP-4361 text of its own fields, name the host of
  `NEXT_PUBLIC_SITE_URL` as its domain and that site's origin as its URI (never the request's Host header), name the
  active chain, carry the site's own statement and no resources, request id or Not Before, and be inside a lifetime of
  at most 10 minutes.
- **Signature.** viem's `verifySiweMessage` over sign-in's own RPC client (CCIP-Read off). It covers ordinary wallets
  and smart-contract wallets (ERC-1271, and ERC-6492 before deployment). That client keeps its own endpoint-health
  record and reads an out-of-gas answer as the node's, so a signature built to burn gas costs one call at one endpoint
  and never puts the endpoints the Inspector, `/api/pulse`, `/badge` and `/t` share on cooldown. Before the check,
  verify reads, without consuming it, that the nonce is stored and live, so a nonce that can't sign in never reaches
  the RPC.
- **Session.** The cookie `__Host-arcos_session` is an HS256 JWT `{ sub: address, aud: site host, iat, exp: +7 days }`,
  signed with `ARCOS_SESSION_SECRET` (a Secret Manager secret of 32 bytes or more) and sent
  `HttpOnly; Secure; SameSite=Lax; Path=/` with no `Domain`, as the `__Host-` prefix requires, so a sibling subdomain can
  neither plant nor overwrite it. A request that carries it twice is treated as signed out. Each sign-in issues a new
  token. It also carries the wallet's session version: signing out moves the version on, so every earlier cookie of
  that wallet, anywhere, stops counting. Rotating the secret signs everyone out. Without the secret, sign-in answers
  503; there is no fallback key.
- **CSRF.** `POST /api/auth/verify` and `POST /api/auth/logout` require an `Origin` equal to the site's own; the verify
  body must be `application/json`. Every auth route is rate-limited per client and answers `no-store`.
- **Logs.** No address, message, signature, cookie or secret reaches a log line; a failure logs the name of the step.

## Rate limiting and the trusted-proxy assumption

`/api/inspect`, `/api/approvals`, `/api/event` and `/api/csp-report` limit each client, in memory and per server
instance: a first line of defence, not a guarantee. A client is the entry of `x-forwarded-for` that the site's own
proxies vouch for (`clientKey` in `apps/web/src/lib/rate-limit.ts`), else `x-real-ip`, else one shared `"unknown"` key.
By default that entry is the rightmost one, the hop the nearest proxy added: every entry to its left is client-supplied
and trivially spoofed, and is never trusted. An IPv6 address counts by its /64, so a client cycling through a block
doesn't dodge its limit.

If a Google load balancer in front of App Hosting adds an entry of its own to the right of the client's, every visitor
is keyed by that one entry and they share a single bucket: stricter, never looser. `ARCOS_TRUSTED_HOPS` (server-only,
optional) says how many entries, counted from the right, belong to the site's own proxies; n skips n entries before it
reads the client. Unset, empty, negative or not a whole number, it is 0, and the rightmost entry is the client's. A
header with n entries or fewer holds no entry the proxies vouch for, so the rightmost is read, the same key as without
the setting: for a header that short the setting is never looser than leaving it unset, whatever n is. The value is
measured, not guessed (`apps/web/apphosting.yaml` says how) and never set higher than the measurement shows. A value
above the real number of the site's own proxies makes the key an entry the client wrote once the client adds entries of
its own to the header, and it can then pick its own bucket on every request. The value is also safe only if every
address the backend answers on, `4rcos.com` and the default `*.hosted.app` address, reaches the app through the same
number of proxies, since one value can't be right for two paths. Both are measured, and if they differ it stays unset.

`x-vercel-forwarded-for` is read only when `process.env.VERCEL === "1"`, which the platform sets and no request can, so
only on a Vercel deployment; anywhere else nothing tells a genuine header from one a client set on itself, and it is
ignored. The live site doesn't run on Vercel. Running the app behind a different reverse proxy that doesn't set these
headers correctly, or exposing it directly to the internet, would let every request collapse onto one key: not a
security hole in itself, but the safety valve for those endpoints would stop being per-client.

## Security headers and the content security policy

Every response carries these headers (`headers()` in `apps/web/next.config.ts`, built in
`apps/web/src/lib/security-headers.ts`):

- `Strict-Transport-Security: max-age=63072000; includeSubDomains`, without `preload`.
- `X-Frame-Options: DENY` and a content security policy of
  `frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'`, both enforced: the windows that ask
  a wallet to sign can't be framed by another site.
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` and a `Permissions-Policy` that
  turns off the camera, microphone, geolocation, payment and browsing-topics features.
- `Cross-Origin-Opener-Policy: same-origin-allow-popups`, not `same-origin`, which would cut a wallet's popup off from
  the page that opened it.

The full policy is sent as `Content-Security-Policy-Report-Only`, so it blocks nothing. It says the page takes its
scripts and styles from itself (and one font stylesheet from Google Fonts, for the WalletConnect modal) and calls only
itself, Arc's RPC nodes and explorers, WalletConnect and Reown, and Circle's App Kit; `security-headers.ts` lists each
host with who calls it. Browsers post what it would have blocked to `/api/csp-report`, which writes a log line (the
directive, the blocked origin or keyword, and the page's path) for at most ten distinct violations per request and
answers 204 to everything. It logs no query string, no address, no client address and no user agent, reads at most
256 KB (Chromium puts the whole policy in every report, and keeps up to 100 for one upload) and limits each client. The
policy watches real traffic for a few days before it is enforced, in a later step.

`script-src` allows `'unsafe-inline'`. Next's own bootstrap scripts and the theme script are inline and carry no nonce,
and a nonce is made for each request, which would make every page render on the server on each visit instead of being
served as a static file. So the policy keeps every other host's script out, but not an inline one: a known gap that
nonces or hashes would close.

## Event counts

The site counts a few things itself, so its maker can see whether they are used: an inspection run, a proof-page share,
a mint, a drop, a swap, a bridge, a revoke, a click on a fix that isn't ready yet, and the name of a Terminal command.
When one happens the page sends its name and a few small values (how many checks passed, how many recipients, which pair
or chains, the command's name) to `/api/event` on this site, and that route writes one line to the host's logs, which on
Firebase App Hosting is Cloud Logging. There are no cookies and no third-party script.

The line holds the event's name and those values and nothing else: no address (a wallet's or a token's), no IP address,
no user agent and nothing typed in the Terminal past a command's name. It has no visitor or session identifier, so a
count says how often something happens and not who did it. The route takes only the nine event names, and for each only
its own values, which are whole numbers up to 1,000,000 or labels of up to 32 letters, digits, dots, underscores and
hyphens (an address is longer, so it can't pass); anything else is dropped. It ignores a body over 2 KB and a request
whose `Origin` is another site, limits each client, and answers 204 to everything. The host keeps its own request log,
as it does for any page, and these counts add nothing to it. They are also separate from what the services the page
calls do on their own: WalletConnect and Reown (below), and Circle's App Kit behind Swap and Bridge, which by default
sends its own usage and error reports to Circle.

## Reading contracts anyone can deploy

Inspector reads whichever token contract a visitor asks about, so CCIP-Read (EIP-3668) is off on every client that
does: the server's three clients (`serverRpcClient`, `approvalsRpcClient` and `authRpcClient` in
`apps/web/src/lib/server-rpc.ts`, all built by `inspectionClient` in `packages/inspector/src/inspection-client.ts`, each
with its own endpoint-health record) — `serverRpcClient` behind `/api/inspect`, `/badge`, `/t` and its image, and
`/api/pulse`; `approvalsRpcClient` behind `/api/approvals` alone, which reads the allowance, symbol, name and decimals
of whatever token contracts an address has approved; `authRpcClient` behind `/api/auth/verify` alone, which checks
smart-wallet signatures — and every client of the browser's wagmi config (`apps/web/src/providers/wagmi.ts`).
With it on, a read that reverts with `OffchainLookup` makes viem fetch URLs the contract chose: from the server, that is
a blind server-side request forgery. Such a revert is read like any other revert. The Circle App Kit clients behind
Swap and Bridge only read Circle's own contracts.

## Connecting a phone wallet

On a phone, where the browser has no wallet extension, Wallet connects through WalletConnect. The page then talks to
WalletConnect's relay, which carries an end-to-end encrypted session between the page and the wallet on the phone; every
transaction is still signed in that wallet. Its modal also asks Reown's servers for the wallet list and the project's
configuration, sends usage events to WalletConnect and loads the Inter font from Google Fonts, so those services see the
visitor's IP address. The Reown project ID (`NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`) is a public client identifier that ships in
the browser bundle; the domain allowlist in the Reown dashboard is what protects it.

The WalletConnect code loads only when a visitor picks WalletConnect, or when a reload restores a live WalletConnect session
they connected earlier. A session that ended or expired costs at most one more load, after which the browser forgets it. It is
a separate chunk, and `apps/web/src/providers/lazyWalletConnect.ts` stops wagmi from importing it on every page load, which its
own connector would do. CCIP-Read stays off in the wagmi config (`apps/web/src/providers/wagmi.ts`), with WalletConnect in it too.

## Dependency exceptions

Deliberate, documented exceptions to this project's "no high/critical `npm audit` findings" rule.

### `toml` (via `@circle-fin/app-kit` → `@coral-xyz/anchor`)

- **Package:** `toml` (transitive, pulled in as `@coral-xyz/anchor`'s dependency `"toml": "^3.0.0"`,
  itself required — not optional — by every `@circle-fin/*-kit` sub-package `@circle-fin/app-kit`
  installs, including `swap-kit` and `bridge-kit`, for their Solana-side providers).
- **Advisories:** GHSA-82x6-q7mm-w9cf (Uncontrolled Recursion, CVSS 7.5) and GHSA-v5mp-jgw5-2x6j
  (Prototype Pollution via `__proto__` key-path desynchronization, CVSS 8.2), both `severity: high`
  per `npm audit --omit=dev` and the GitHub Advisory Database, both affecting `toml < 4.2.0`. The
  installed version (`3.0.0`, the only `3.x` release ever published) has no in-range patch — the
  first patched release is `4.2.0`, a different major than what `@coral-xyz/anchor@^3.0.0` (checked
  up to its own latest, `0.32.1`) declares.
- **Why it's unreachable here:** both advisories require parsing attacker-controlled TOML text.
  4rc.OS never parses TOML anywhere in its own code, on the client or the server. Inside
  `@coral-xyz/anchor`, `toml` is used to load `Anchor.toml` workspace configuration — a
  Solana-CLI/Node-only code path for reading a local project's own config file, not something this
  app's Swap or Bridge windows import or execute; the app only uses `@circle-fin/app-kit`'s
  EVM/viem adapter path (`createViemAdapterFromProvider`) against Arc and other EVM chains, never
  the SDK's Solana providers or their CLI tooling.
- **Override applied (root `package.json`, alongside the existing `ws` override):**
  ```json
  "overrides": { "toml": "^4.2.0" }
  ```
  Resolves to `toml@4.3.0` as of 2026-09-20. `@coral-xyz/anchor@0.31.1` (the version `app-kit`
  pulls) was written against `toml@^3.0.0`; this override installs a newer major than it declares
  support for. `npm run build`, the full test suite, and a standalone `new AppKit()` smoke script
  all ran clean against the forced version — `toml`'s own public API (`parse(string) -> object`)
  is small and unchanged across this jump, and Anchor's usage of it is a single, simple parse call.
- **Decided by:** the project owner, in chat, 2026-09-20 — a deliberate, documented exception, not
  a default resolution path. This project's normal default is to keep a forced `overrides` bump
  within the same major version, to avoid exactly this kind of unreviewed breaking change; this
  entry is a narrow, explicitly-tracked exception to that default (rather than a silent one),
  justified by there being no in-range `3.x` patch and by `toml`'s tiny, stable public API making
  the major jump low-risk in practice (see the verification above).
- **Exit condition:** remove the override once `@circle-fin/app-kit` (directly or via
  `@coral-xyz/anchor`) depends on `toml >= 4.2.0` on its own, or drops the CCTP-Solana / Anchor
  dependency entirely for the providers this app doesn't use. Re-run `npm audit --omit=dev` after
  removing it to confirm the override is no longer needed before deleting this section.
