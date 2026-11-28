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
The server also reads a fourth, `INSPECT_RPC_KEY`, the RPC provider's key for the Inspector's other chains (below), which
`apphosting.yaml` doesn't name yet: until it does, those reads use the chains' public RPCs. It will be set up the same
way ([docs/DEPLOYING.md](docs/DEPLOYING.md#the-inspectors-other-chains)).
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
instance: a first line of defence, not a guarantee. So do the Inspector's pages for chains other than Arc
(`/t/<chain>/<address>`, its social card and `/badge/<chain>/<address>`, 30 a minute together), since each of them can
spend the RPC provider's paid quota; Arc's `/t` and `/badge` stay unlimited. A client is the entry of `x-forwarded-for`
that the site's own proxies vouch for (`clientKey` in `apps/web/src/lib/rate-limit.ts`), else `x-real-ip`, else one
shared `"unknown"` key. By default that entry is the rightmost one, the hop the nearest proxy added: every entry to its
left is client-supplied and trivially spoofed, and is never trusted. An IPv6 address counts by its /64, so a client
cycling through a block doesn't dodge its limit.

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
host with who calls it. The Inspector's reads of other chains are the server's, so the policy names none of their hosts
(a test checks that `connect-src` names no `alchemy.com`, `blockscout.com` or `sourcify.dev` host). Browsers post what
it would have blocked to `/api/csp-report`, which writes a log line (the directive, the blocked origin or keyword, and
the page's path) for at most ten distinct violations per request and answers 204 to everything. It logs no query string,
no address, no client address and no user agent, reads at most 256 KB (Chromium puts the whole policy in every report,
and keeps up to 100 for one upload) and limits each client. The policy watches real traffic for a few days before it is
enforced, in a later step.

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

Inspector reads whichever token contract a visitor asks about, so CCIP-Read (EIP-3668) is off on every client that does:
the server's four clients (`serverRpcClient`, `approvalsRpcClient`, `authRpcClient` and `watchRpcClient` in
`apps/web/src/lib/server-rpc.ts`, all built by `inspectionClient` in `packages/inspector/src/inspection-client.ts`, each
with its own endpoint-health record) — `serverRpcClient` behind `/api/inspect`, `/badge`, `/t` and its image, and
`/api/pulse` (and, for each of the Inspector's other chains, `inspectRpcClient` behind the same routes' chain forms);
`approvalsRpcClient` behind `/api/approvals` alone, which reads the allowance, symbol, name and decimals of whatever
token contracts an address has approved; `authRpcClient` behind `/api/auth/verify` alone, which checks smart-wallet
signatures; `watchRpcClient` behind `POST /api/watches` alone, which checks that the token address a signed-in wallet
adds holds code — and every client of the browser's wagmi config (`apps/web/src/providers/wagmi.ts`). With it on, a read
that reverts with `OffchainLookup` makes viem fetch URLs the contract chose: from the server, that is a blind
server-side request forgery. Such a revert is read like any other revert. The Circle App Kit clients behind Swap and
Bridge only read Circle's own contracts.

## The Inspector's other chains

The Inspector reads Ethereum, Base, Arbitrum One and OP Mainnet only from the site's server, and only for the chains
`NEXT_PUBLIC_INSPECT_CHAINS` switches on; every other chain slug answers 404
([docs/INSPECTOR-CHAINS.md](docs/INSPECTOR-CHAINS.md)).

- **The key.** `INSPECT_RPC_KEY` is a server-only runtime secret, read in one file, `apps/web/src/lib/rpc-urls.ts`, which
  only `server-rpc.ts` imports (a test pins both, and that no `NEXT_PUBLIC_` name holds a key). It is sent in the
  `Authorization: Bearer` header to the provider's fixed hosts (`eth-mainnet`, `base-mainnet`, `arb-mainnet` and
  `opt-mainnet.g.alchemy.com`), never in a URL: viem writes the URL into its error messages, and the routes log an
  error's name only. Being read at runtime only, the key is in no build. The deploy's bundle scan
  (`scripts/scan-bundle.mjs`) looks for the strings in its secret list in both the browser and the server build, and a
  line there for a key put into an Alchemy URL at build time, never the key itself, is an optional owner step
  ([docs/DEPLOYING.md](docs/DEPLOYING.md#the-inspectors-other-chains)). Without the key, or with the value `none`, the
  server reads each chain's public RPC.
- **Where requests go.** Every host is fixed in code: the provider, each chain's public RPC, Blockscout's PRO API by
  chain id, and `sourcify.dev`. The only part a visitor chooses is the address, which must be a 20-byte hex address
  before anything is read, and the chain, which must be one switched on. CCIP-Read stays off, so a contract can't send
  the server anywhere.
- **Spending.** Each chain's pages, card and badge take a turn from a per-client limiter (above), and the explorer reads
  for these chains have a daily budget per server instance ([docs/OPERATIONS.md](docs/OPERATIONS.md#the-inspectors-other-chains)).
  Walking many addresses costs a client its turns, not the site's quota. At most 4 uncached inspections of these chains
  run at once in an instance, in a gate apart from Arc's 8, so that walk can fill these chains' gate but never takes one
  of Arc's slots.

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
- **Advisories:** GHSA-4qx8-w7c3-pj3p, GHSA-9j65-hcg3-gc64 and GHSA-9qmh-m7c6-f92p (CPU denial of service in
  `toml.parse()`), all `severity: high`, all affecting `toml <= 5.0.0` (they replace the two advisories
  GHSA-82x6-q7mm-w9cf and GHSA-v5mp-jgw5-2x6j that the first override, `^4.2.0`, settled on 2026-09-20). The installed
  version (`3.0.0`, the only `3.x` release ever published) has no in-range patch: the first patched release is
  `5.0.1`, two majors above what `@coral-xyz/anchor` declares (`^3.0.0`, checked up to its own latest, `0.32.1`).
- **Why it's unreachable here:** both advisories require parsing attacker-controlled TOML text.
  ArcOS never parses TOML anywhere in its own code, on the client or the server. Inside
  `@coral-xyz/anchor`, `toml` is used to load `Anchor.toml` workspace configuration — a
  Solana-CLI/Node-only code path for reading a local project's own config file, not something this
  app's Swap or Bridge windows import or execute; the app only uses `@circle-fin/app-kit`'s
  EVM/viem adapter path (`createViemAdapterFromProvider`) against Arc and other EVM chains, never
  the SDK's Solana providers or their CLI tooling.
- **Override applied (root `package.json`, alongside the existing `ws` override):**
  ```json
  "overrides": { "toml": "^5.0.1" }
  ```
  Resolves to `toml@5.0.1` as of 2026-10-30 (it was `4.3.0` from 2026-09-20). `@coral-xyz/anchor@0.31.1` (the version `app-kit`
  pulls) was written against `toml@^3.0.0`; this override installs a newer major than it declares
  support for. On 2026-10-30, against 5.0.1, `npm run build`, the full test suite, a standalone `new AppKit()` smoke script
  and an import of `@coral-xyz/anchor` all ran clean (5.0.1 is still CommonJS, `engines.node >=20`) — `toml`'s own public API (`parse(string) -> object`)
  is small and unchanged across this jump, and Anchor's usage of it is a single, simple parse call.
- **Decided by:** the project owner, in chat, 2026-09-20, for the jump to `^4.2.0`, and again on 2026-10-30 for the move on to `^5.0.1`
  — a deliberate, documented exception, not
  a default resolution path. This project's normal default is to keep a forced `overrides` bump
  within the same major version, to avoid exactly this kind of unreviewed breaking change; this
  entry is a narrow, explicitly-tracked exception to that default (rather than a silent one),
  justified by there being no in-range `3.x` patch and by `toml`'s tiny, stable public API making
  the major jump low-risk in practice (see the verification above).
- **Exit condition:** remove the override once `@circle-fin/app-kit` (directly or via
  `@coral-xyz/anchor`) depends on `toml >= 4.2.0` on its own, or drops the CCTP-Solana / Anchor
  dependency entirely for the providers this app doesn't use. Re-run `npm audit --omit=dev` after
  removing it to confirm the override is no longer needed before deleting this section.

### `zod` (via `@circle-fin/*` and `@reown/appkit-wallet`)

- **Advisory:** GHSA-mrhx-c7xc-m3w5 (`severity: high`): validating an oversized array, map or set can exhaust
  memory (`handleArrayResult` in zod's v4 core). It is fixed in `zod 4.6.6`; no `3.x` release carries a patch. The flagged
  range `<4.6.6` takes in `3.x`, which is what the Circle and Reown packages import, and that code path (`handleArrayResult`)
  exists only in `zod/v4/core`, which nothing here imports; npm reports the packages all the same.
- **Why there is no fix here:** every `@circle-fin/*` package pins `zod` at exactly `3.25.67` (their latest releases
  too, `@circle-fin/app-kit 1.23.0` among them, checked 2026-11-24) and `@reown/appkit-wallet` pins `3.22.4`. A `zod`
  override to `4.x` breaks Circle's v3 schemas: `z.function().returns(...)`, which its fee options use (still so in
  `app-kit 1.23.0`), does not exist in `zod 4` (`z.function(...).returns is not a function`), and
  `required_error`/`invalid_type_error` messages are dropped.
  `viem`, `abitype` and `wagmi` are flagged only through `abitype`'s optional `zod` peer, which the app never imports (`abitype/zod` is a separate entry point).
- **Exposure:** a visitor's own browser tab, on input the SDKs validate (the app's forms, their vendors' replies).
- **Decided by:** the project owner, in chat, 2026-10-30, and again on 2026-11-24, by merging pull request #63, for the
  renewal until 2026-12-29.
- **Handled by:** an expiring entry in `scripts/audit-allowlist.json` (`runtime: true`, until 2026-12-29). Remove it
  once the Circle packages move to a patched `zod` and the Reown copy is dealt with. That copy can't move by an
  upgrade: `@walletconnect/ethereum-provider` stays at `2.21.8`, its last Apache-2.0 release (see `query-string`
  below), which pins `@reown/appkit 1.7.8` and so `@reown/appkit-wallet 1.7.8` with its `zod 3.22.4`. It would need a
  scoped override to a patched `zod`, checked on its own.

### `picomatch` (via vitest and its vite, the ESLint config, WalletConnect's `unstorage`, and the Firebase CLI)

- **Advisory:** GHSA-fc5q-39xc-vjpf (`severity: high`, published 2026-10-19): a glob pattern made of single-branch
  repeated extglobs (`+(*)`, `+(*a)`) compiles to a regular expression that backtracks exponentially, blocking the event
  loop. It covers `picomatch <= 4.0.7`. 4.0.7 is the latest release, and 2.3.2 (the line `anymatch`, `readdirp` and
  `micromatch` use) the latest 2.x, so there is no version to update or override to.
- **Why it isn't exploitable here:** the attacker has to supply the glob pattern. picomatch does run here, but every
  pattern it gets is ours:
  - vitest (and its vite) and the lint config (`eslint-config-next` → `fast-glob` → `micromatch`; typescript-eslint and
    `eslint-import-resolver-typescript` → `tinyglobby`) glob this repository's own config and source, at test and lint
    time only.
  - In the root lockfile picomatch is also a runtime dependency, through `@walletconnect/keyvaluestorage` →
    `unstorage` → `anymatch`. `unstorage` loads `anymatch` only in its Node `fs` driver. WalletConnect's browser build
    imports only `unstorage`'s core (it carries its own IndexedDB driver) and its Node build `unstorage/drivers/fs-lite`,
    so nothing in the web build loads the npm `anymatch` or `picomatch` packages. Next's server ships its own copy of
    picomatch, which matches only the `images` patterns from `next.config`, and there are none.
  - The pinned Firebase CLI (`tools/firebase`) reaches picomatch only through `chokidar`, which its Firestore emulator
    uses to watch our rules file in CI's emulator runs. Its other path, `node-gyp` → `tinyglobby`, never
    runs: every install of the CLI uses `npm ci --ignore-scripts`.
- **Decided by:** the project owner, in chat, 2026-11-17.
- **Handled by:** two expiring entries in `scripts/audit-allowlist.json`, one for the root audit and one for
  `tools/firebase` (both `runtime: true`, until 2026-12-17). Remove them once patched releases cover both lines in use
  (2.x and 4.x) and the lockfiles pick them up. If only 4.x is patched, moving the picomatch under `anymatch`, `readdirp`
  and `micromatch` to 4.x crosses a major version and needs its own check, as with `toml` above.

### `query-string` (via `@walletconnect/utils`)

- **Advisory:** GHSA-qr28-fpjm-wq7f (`decode-uri-component <= 0.5.0`, denial of service). `@walletconnect/utils`
  (2.21.8 and the 2.21.0 copies under `@reown/*`) declares `query-string 7.1.3`, which needs `decode-uri-component`.
  The only patched release, `0.5.1`, is ESM-only, so overriding it breaks `query-string 7`
  (`decodeComponent is not a function`).
- **Override applied:** `"query-string": "^10.0.0"`, which does not use `decode-uri-component` at all. No file of the
  installed `@walletconnect/*` or `@reown/*` packages, and nothing in the web build, loads `query-string`; it is a
  declared dependency only. Remove the override once WalletConnect drops the dependency (the packages are pinned at
  their last Apache-2.0 release; see `apps/web/src/providers/wagmi.ts`).
