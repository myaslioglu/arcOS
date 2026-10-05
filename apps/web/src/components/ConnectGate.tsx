"use client";

import { useConnection } from "wagmi";
import { useDesktop } from "@arcos/shell";
import { useArcNetwork } from "@/lib/network";

/**
 * Apps that sign transactions render inside this: it asks for a wallet, and for Arc.
 *
 * `anyNetwork` drops the second ask. Bridge sets it: Circle's App Kit switches the wallet itself, to the source chain
 * for the approval and the burn and to the destination chain for the mint, so while a bridge runs the wallet is on
 * another network by design, and after one it stays there. Gating on Arc would unmount the window in the middle of
 * every bridge that touches another chain, and hide its result behind "Switch to Arc" when it is done.
 */
export function ConnectGate({ children, anyNetwork = false }: { children: React.ReactNode; anyNetwork?: boolean }) {
  const { isConnected } = useConnection();
  const { chain, wrongNetwork, switching, switchError, switchToArc } = useArcNetwork();
  const { open } = useDesktop();

  if (!isConnected) {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-sm">
        <div>
          <p className="text-muted">Connect a wallet to use this app.</p>
          <button type="button" className="mt-3 rounded-lg border border-border-2 px-3 py-1.5" onClick={() => open("wallet")}>
            Open Wallet
          </button>
        </div>
      </div>
    );
  }
  if (wrongNetwork && !anyNetwork) {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-sm">
        <div>
          <p className="text-muted">Your wallet is on another network.</p>
          <button
            type="button"
            disabled={switching}
            className="mt-3 rounded-lg border border-border-2 px-3 py-1.5"
            onClick={switchToArc}
          >
            Switch to {chain.name}
          </button>
          {switchError && <p className="mt-2 text-accent-3-text">{switchError}</p>}
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
