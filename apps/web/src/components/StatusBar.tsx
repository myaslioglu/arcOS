"use client";

import { useAccount, useBalance } from "wagmi";
import { Wallet } from "lucide-react";
import { formatUsdc } from "@arcos/chain";
import { useDesktop } from "@arcos/shell";
import { useArcNetwork } from "@/lib/network";
import { shortAddress } from "@/lib/format";

// No explicit font-size here: `.os-topbar` sets 11px mono for the bar, and
// this slot inherits it so it matches the clock next to it.
export function StatusBar() {
  const { address } = useAccount();
  const { chain, wrongNetwork, switching, switchError, switchToArc } = useArcNetwork();
  const { open } = useDesktop();
  const { data: balance } = useBalance({ address, chainId: chain.id, query: { refetchInterval: 15_000 } });

  return (
    <div className="flex items-center gap-3">
      {wrongNetwork ? (
        <span className="flex items-center gap-2">
          <button type="button" disabled={switching} className="text-accent-3-text underline" onClick={switchToArc}>
            Switch to {chain.name}
          </button>
          {switchError && <span className="text-accent-3-text">{switchError}</span>}
        </span>
      ) : (
        <span className="text-muted">{chain.name}</span>
      )}
      <button type="button" className="flex items-center gap-1.5" onClick={(e) => open("wallet", {}, e.currentTarget)}>
        <Wallet size={14} aria-hidden />
        {address ? (
          <span>
            {shortAddress(address)}
            {balance ? ` · ${formatUsdc(balance.value)} USDC` : ""}
          </span>
        ) : (
          <span>Connect wallet</span>
        )}
      </button>
    </div>
  );
}
