"use client";

import { useSyncExternalStore } from "react";
import { useAccount, useBalance, useConnect, useDisconnect } from "wagmi";
import { explorerUrl, formatUsdc } from "@arcos/chain";
import { useArcNetwork } from "@/lib/network";
import { visibleConnectors } from "@/providers/wagmi";

const noSubscription = () => () => {};

/** True once the page can see a browser wallet's injected provider — not just wagmi's static
 * `injected()` connector, which exists whether or not anything answers it. False through
 * prerendering and the hydration pass, same trick as `useIsTouch`, so markup matches. */
function useHasInjectedProvider(): boolean {
  return useSyncExternalStore(
    noSubscription,
    () => "ethereum" in window,
    () => false,
  );
}

export default function WalletWindow() {
  const { address, isConnected, connector } = useAccount();
  const { chain, wrongNetwork, switching, switchError, switchToArc } = useArcNetwork();
  const { connectors: allConnectors, connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const { data: balance } = useBalance({ address, chainId: chain.id });
  const hasInjectedProvider = useHasInjectedProvider();
  const connectors = visibleConnectors(allConnectors, hasInjectedProvider);

  if (!isConnected) {
    return (
      <div className="p-5 text-sm">
        <p className="font-medium">Connect a wallet</p>
        <p className="mt-1 text-muted">ARC.os never sees your keys. Every action is signed in your wallet.</p>
        {connectors.length > 0 ? (
          <ul className="mt-4 grid gap-2">
            {connectors.map((c) => (
              <li key={c.uid}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-lg border border-border-2 px-3 py-2 text-left"
                  onClick={() => connect({ connector: c, chainId: chain.id })}
                >
                  {c.icon && (
                    <span
                      aria-hidden
                      className="h-4 w-4 shrink-0 rounded bg-cover bg-center"
                      style={{ backgroundImage: `url(${c.icon})` }}
                    />
                  )}
                  {c.name}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 text-muted">No wallet found in this browser. Install a browser wallet that supports Arc, then reload.</p>
        )}
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
        <dd>{wrongNetwork ? "Another network" : chain.name}</dd>
        <dt className="text-muted">Balance</dt>
        <dd>{balance ? `${formatUsdc(balance.value)} USDC` : "—"}</dd>
      </dl>
      <div className="mt-5 flex gap-2">
        {wrongNetwork && (
          <button type="button" disabled={switching} className="rounded-lg border border-border-2 px-3 py-1.5" onClick={switchToArc}>
            Switch to {chain.name}
          </button>
        )}
        <button type="button" className="rounded-lg border border-border-2 px-3 py-1.5" onClick={() => disconnect()}>
          Disconnect
        </button>
      </div>
      {switchError && <p className="mt-3 text-accent-3-text">{switchError}</p>}
    </div>
  );
}
