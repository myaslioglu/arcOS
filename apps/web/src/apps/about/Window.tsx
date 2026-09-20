"use client";

import { ARCOS, activeChain, activeNetwork, explorerUrl } from "@arcos/chain";
import { REPO_URL } from "@/lib/site";

const CONTRACT_LABEL = { feeController: "FeeController", tokenFactory: "TokenFactory", multisend: "Multisend" } as const;

export default function AboutWindow() {
  const network = activeNetwork();
  const chain = activeChain();
  const contracts = ARCOS[network];

  return (
    <div className="p-5 text-sm leading-6">
      <p className="text-base font-medium">ARC.os</p>
      <p className="mt-2 text-muted">
        {"A desktop for Circle's Arc network: inspect a token, mint one and send to many wallets at once."}
      </p>

      <dl className="mt-4 grid grid-cols-[96px_1fr] gap-y-2">
        <dt className="text-muted">Network</dt>
        <dd>{chain.name}</dd>
        <dt className="text-muted">Contracts</dt>
        <dd>
          {contracts ? (
            <ul className="grid gap-1">
              {(Object.keys(CONTRACT_LABEL) as (keyof typeof CONTRACT_LABEL)[]).map((key) => (
                <li key={key}>
                  <a
                    className="break-all font-mono text-xs text-accent-text"
                    href={explorerUrl("address", contracts[key])}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {CONTRACT_LABEL[key]}: {contracts[key]}
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-muted">{`Not deployed on ${chain.name} yet.`}</span>
          )}
        </dd>
      </dl>

      <p className="mt-4 text-muted">Contracts are not upgradeable and hold no funds between transactions.</p>
      <p className="mt-2 text-muted">These contracts haven&apos;t been audited by a third party.</p>

      <ul className="mt-4 grid gap-1 text-xs text-faint">
        <li>{'Explorer data can be unavailable; when it is, checks read "unknown" instead of pass or fail.'}</li>
        <li>{"Liquidity and lock checks cover Uniswap v2/v3 against USDC and EURC only; v4 and Aerodrome aren't scanned yet."}</li>
        <li>{"Swap and Bridge run on Circle's App Kit in keyless mode and charge a 0.20% platform fee, split 90/10 with Arc, only when a fee recipient is configured."}</li>
        <li>{"Bridge covers EVM chains only — no Solana yet, and it shows each step once a transfer settles rather than live progress while it's in flight."}</li>
      </ul>

      {REPO_URL && (
        <p className="mt-4">
          <a className="text-accent-text" href={REPO_URL} target="_blank" rel="noreferrer">
            Source on GitHub
          </a>
        </p>
      )}

      <p className="mt-4 text-xs text-faint">Automated analysis, not investment advice.</p>
    </div>
  );
}
