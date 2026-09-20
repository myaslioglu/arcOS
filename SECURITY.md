# Security policy

## Scope

This covers the code in this repository:

- The three Solidity contracts in `packages/contracts` (`FeeController`, `TokenFactory`,
  `Multisend`), deployed or not.
- The web app in `apps/web`, including its API routes.

Third-party dependencies (Next.js, wagmi, viem, OpenZeppelin, and the rest) are out of scope —
report those upstream.

## Reporting a vulnerability

Email security@yaslioglu.com with a description of the issue, the steps to reproduce it, and its
impact. Include a contract address and network if the issue is on-chain.

Please don't open a public GitHub issue for a security report, and don't test a finding against
mainnet contracts or real funds beyond what's needed to demonstrate it.

There's no bounty program at this time.

## What to expect

An acknowledgement within a few business days, and a report back once the issue is understood or
fixed. Coordinated disclosure — please give us time to address a report before making it public.
