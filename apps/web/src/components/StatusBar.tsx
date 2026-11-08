"use client";

import { useEffect } from "react";
import { useConnection, useBalance } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { Wallet } from "lucide-react";
import { formatUsdc } from "@arcos/chain";
import { useDesktop } from "@arcos/shell";
import { watchBalanceChanges } from "@/lib/balance-refresh";
import { displayWei } from "@/lib/display-amount";
import { useArcNetwork } from "@/lib/network";
import { shortAddress } from "@/lib/format";

// No explicit font-size here: `.os-topbar` sets 11px mono for the bar, and
// this slot inherits it so it matches the clock next to it.
export function StatusBar() {
  const { address } = useConnection();
  const { chain, wrongNetwork, switching, switchError, switchToArc } = useArcNetwork();
  const { open } = useDesktop();
  const { data: balance } = useBalance({ address, chainId: chain.id, query: { refetchInterval: 15_000 } });
  const queryClient = useQueryClient();
  // Apps call notifyBalanceChanged() when a transaction of theirs lands; this bar is always mounted, so it listens.
  useEffect(() => watchBalanceChanges(queryClient), [queryClient]);

  return (
    <div className="flex min-w-0 items-center gap-3">
      {wrongNetwork ? (
        <span className="flex items-center gap-2">
          <button type="button" disabled={switching} className="text-accent-3-text underline" onClick={switchToArc}>
            Switch to {chain.name}
          </button>
          {switchError && <span className="text-accent-3-text">{switchError}</span>}
        </span>
      ) : (
        <span className="text-muted max-[479px]:hidden">{chain.name}</span>
      )}
      <button
        type="button"
        className="flex min-w-0 items-center gap-1.5 whitespace-nowrap"
        title={address && balance ? `${formatUsdc(balance.value)} USDC` : undefined}
        onClick={(e) => open("wallet", {}, e.currentTarget)}
      >
        <Wallet size={14} aria-hidden className="shrink-0" />
        {address ? (
          <span className="min-w-0 truncate">
            {shortAddress(address)}
            {balance ? ` · ${displayWei(balance.value, "down")} USDC` : ""}
          </span>
        ) : (
          <span className="min-w-0 truncate">Connect wallet</span>
        )}
      </button>
    </div>
  );
}
