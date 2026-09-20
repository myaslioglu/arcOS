"use client";

import { useAccount, useBalance, useSwitchChain } from "wagmi";
import { Wallet } from "lucide-react";
import { activeChain, formatUsdc } from "@arcos/chain";
import { useDesktop } from "@arcos/shell";
import { shortAddress } from "@/lib/format";

// No explicit font-size here: `.os-topbar` sets 11px mono for the bar, and
// this slot inherits it so it matches the clock next to it.
export function StatusBar() {
  const chain = activeChain();
  const { address, chainId, isConnected } = useAccount();
  const { switchChain } = useSwitchChain();
  const { open } = useDesktop();
  const { data: balance } = useBalance({ address, chainId: chain.id, query: { refetchInterval: 15_000 } });
  const wrongNetwork = isConnected && chainId !== chain.id;

  return (
    <div className="flex items-center gap-3">
      {wrongNetwork ? (
        <button type="button" className="text-accent-3-text underline" onClick={() => switchChain({ chainId: chain.id })}>
          Switch to {chain.name}
        </button>
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
