"use client";

import { useAccount } from "wagmi";
import { useDesktop } from "@arcos/shell";
import { useArcNetwork } from "@/lib/network";

/** Apps that sign transactions render inside this. */
export function ConnectGate({ children }: { children: React.ReactNode }) {
  const { isConnected } = useAccount();
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
  if (wrongNetwork) {
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
