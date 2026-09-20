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
  ARC.os never parses TOML anywhere in its own code, on the client or the server. Inside
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
