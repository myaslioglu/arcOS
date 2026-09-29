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

## Rate limiting and the trusted-proxy assumption

`/api/inspect` and `/api/approvals` key their per-client rate limits off `x-vercel-forwarded-for` when present AND
`process.env.VERCEL === "1"` (set by the platform itself, never by a request — so a deployment
that isn't actually running on Vercel never trusts a header a client could set on itself),
otherwise the rightmost entry of `x-forwarded-for`, otherwise `x-real-ip` (see `clientKey` in
`apps/web/src/lib/rate-limit.ts`). On Vercel, this assumes the platform's edge network appends the
real client IP as the last hop of that header chain and strips or overwrites anything a client
tried to inject — the leftmost entries of `x-forwarded-for` are client-controlled and never
trusted for this decision. Running this app behind a different reverse proxy that doesn't set one
of these headers correctly (or exposing it directly to the internet without one) would let every
request collapse onto the `"unknown"` key, sharing one limit — not a security hole in itself, but
it does mean the safety valve for those endpoints stops being per-client.

## Security headers and the content security policy

Every response carries these headers (`headers()` in `apps/web/next.config.ts`, built in `apps/web/src/lib/security-headers.ts`):

- `Strict-Transport-Security: max-age=63072000; includeSubDomains`, without `preload`.
- `X-Frame-Options: DENY` and a content security policy of `frame-ancestors 'none'; object-src 'none'; base-uri 'none';
  form-action 'self'`, both enforced: the windows that ask a wallet to sign can't be framed by another site.
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` and a `Permissions-Policy` that
  turns off the camera, microphone, geolocation, payment and browsing-topics features.
- `Cross-Origin-Opener-Policy: same-origin-allow-popups`, not `same-origin`, which would cut a wallet's popup off from the
  page that opened it.

The full policy is sent as `Content-Security-Policy-Report-Only`, so it blocks nothing. It says the page takes its scripts
and styles from itself (and one font stylesheet from Google Fonts, for the WalletConnect modal) and calls only itself,
Arc's RPC nodes and explorers, WalletConnect and Reown, and Circle's App Kit; `security-headers.ts` lists each host with
who calls it. Browsers post what it would have blocked to `/api/csp-report`,
which writes one log line for each violation (the directive, the blocked origin or keyword, and the page's path) and
answers 204 to everything. It logs no query string, no address, no client address and no user agent, reads at most 16 KB
and limits each client. The policy watches real traffic for a few days before it is enforced, in a later step.

`script-src` allows `'unsafe-inline'`. Next's own bootstrap scripts and the theme script are inline and carry no nonce, and
a nonce is made for each request, which would make every page render on the server on each visit instead of being served
as a static file. So the policy keeps every other host's script out, but not an inline one: a known gap that nonces or
hashes would close.

## Reading contracts anyone can deploy

Inspector reads whichever token contract a visitor asks about, so CCIP-Read (EIP-3668) is off on every client that
does: the server's two clients (`serverRpcClient` and `approvalsRpcClient` in `apps/web/src/lib/server-rpc.ts`, both
built by `inspectionClient` in `apps/web/src/lib/inspection-client.ts`, each with its own endpoint-health record) —
`serverRpcClient` behind `/api/inspect`, `/badge`, `/t` and its image, and `/api/pulse`; `approvalsRpcClient` behind
`/api/approvals` alone, which reads the allowance, symbol, name and decimals of whatever token contracts an address
has approved — and every client of the browser's wagmi config (`apps/web/src/providers/wagmi.ts`).
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
