"use client";

import { useAccount, useBalance, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { activeChain, explorerUrl, formatUsdc } from "@arcos/chain";

export default function WalletWindow() {
  const chain = activeChain();
  const { address, chainId, isConnected, connector } = useAccount();
  const { connectors, connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const { data: balance } = useBalance({ address, chainId: chain.id });

  if (!isConnected) {
    return (
      <div className="p-5 text-sm">
        <p className="font-medium">Connect a wallet</p>
        <p className="mt-1 text-muted">ARC.os never sees your keys. Every action is signed in your wallet.</p>
        <ul className="mt-4 grid gap-2">
          {connectors.map((c) => (
            <li key={c.uid}>
              <button
                type="button"
                className="w-full rounded-lg border border-border-2 px-3 py-2 text-left"
                onClick={() => connect({ connector: c, chainId: chain.id })}
              >
                {c.name}
              </button>
            </li>
          ))}
        </ul>
        {connectors.length === 0 && <p className="mt-4 text-muted">No wallet found in this browser.</p>}
        {isPending && <p className="mt-3 text-muted">Waiting for your wallet…</p>}
        {error && <p className="mt-3 text-accent-3-text">{error.message}</p>}
      </div>
    );
  }

  return (
    <div className="p-5 text-sm">
      <p className="font-medium">{connector?.name ?? "Wallet"}</p>
      <a className="mt-1 block break-all font-mono text-xs text-accent-text" href={explorerUrl("address", address!)} target="_blank" rel="noreferrer">
        {address}
      </a>
      <dl className="mt-4 grid grid-cols-[96px_1fr] gap-y-2">
        <dt className="text-muted">Network</dt>
        <dd>{chainId === chain.id ? chain.name : "Another network"}</dd>
        <dt className="text-muted">Balance</dt>
        <dd>{balance ? `${formatUsdc(balance.value)} USDC` : "—"}</dd>
      </dl>
      <div className="mt-5 flex gap-2">
        {chainId !== chain.id && (
          <button type="button" className="rounded-lg border border-border-2 px-3 py-1.5" onClick={() => switchChain({ chainId: chain.id })}>
            Switch to {chain.name}
          </button>
        )}
        <button type="button" className="rounded-lg border border-border-2 px-3 py-1.5" onClick={() => disconnect()}>
          Disconnect
        </button>
      </div>
    </div>
  );
}
