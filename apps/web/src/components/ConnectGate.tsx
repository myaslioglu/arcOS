"use client";

import { useAccount, useSwitchChain } from "wagmi";
import { activeChain } from "@arcos/chain";
import { useDesktop } from "@arcos/shell";

/** Apps that sign transactions render inside this. */
export function ConnectGate({ children }: { children: React.ReactNode }) {
  const chain = activeChain();
  const { isConnected, chainId } = useAccount();
  const { switchChain } = useSwitchChain();
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
  if (chainId !== chain.id) {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-sm">
        <div>
          <p className="text-muted">Your wallet is on another network.</p>
          <button
            type="button"
            className="mt-3 rounded-lg border border-border-2 px-3 py-1.5"
            onClick={() => switchChain({ chainId: chain.id })}
          >
            Switch to {chain.name}
          </button>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
