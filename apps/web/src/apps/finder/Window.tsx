"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { erc20Abi, formatUnits } from "viem";
import { Coins } from "lucide-react";
import { ARCOS, activeChain, activeNetwork, explorerUrl, tokenFactoryAbi, type Address } from "@arcos/chain";
import { blockscoutSource } from "@arcos/inspector";
import { dragSourceProps, useDesktop } from "@arcos/shell";
import { ConnectGate } from "@/components/ConnectGate";
import { mergeTokens, type TokenFile } from "./tokens";

function Files() {
  const { address } = useAccount();
  const { open } = useDesktop();
  const network = activeNetwork();
  const chain = activeChain();
  const factory = ARCOS[network]?.tokenFactory;
  const apiUrl = chain.blockExplorers?.default.apiUrl;
  const [selected, setSelected] = useState<TokenFile | null>(null);

  const holdings = useQuery({
    queryKey: ["holdings", network, address],
    enabled: !!address && !!apiUrl,
    retry: false,
    refetchInterval: 30_000,
    queryFn: () => blockscoutSource(apiUrl!).tokenBalances(address!),
  });

  const created = useReadContract({
    address: factory,
    abi: tokenFactoryAbi,
    functionName: "tokensOf",
    args: address ? [address] : undefined,
    chainId: chain.id,
    query: { enabled: !!address && !!factory, refetchInterval: 15_000 },
  });
  const createdList = useMemo(() => (created.data ?? []) as readonly Address[], [created.data]);

  const meta = useReadContracts({
    contracts: createdList.flatMap((token) => [
      { address: token, abi: erc20Abi, functionName: "symbol", chainId: chain.id } as const,
      { address: token, abi: erc20Abi, functionName: "decimals", chainId: chain.id } as const,
    ]),
    query: { enabled: createdList.length > 0 },
  });

  const files = useMemo(() => {
    const mine = createdList.map((token, i) => ({
      address: token,
      symbol: (meta.data?.[i * 2]?.result as string | undefined) ?? "…",
      decimals: (meta.data?.[i * 2 + 1]?.result as number | undefined) ?? 18,
    }));
    return mergeTokens(holdings.data ?? [], mine);
  }, [createdList, meta.data, holdings.data]);

  return (
    <div className="flex h-full flex-col text-sm">
      {holdings.isError && (
        <p className="border-b border-border px-4 py-2 text-xs text-muted">
          {"The explorer didn't answer, so only tokens you created here are listed."}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {files.length === 0 ? (
          <p className="p-3 text-muted">No tokens yet. Create one in Mint, or receive some.</p>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-1">
            {files.map((f) => (
              <li key={f.address}>
                <button
                  type="button"
                  className="os-icon w-full"
                  aria-pressed={selected?.address === f.address}
                  onClick={() => setSelected(f)}
                  onDoubleClick={() => open("inspector", { token: f.address })}
                  {...dragSourceProps({ kind: "token", address: f.address, symbol: f.symbol, decimals: f.decimals })}
                >
                  <span className="os-icon-tile os-icon-tile--sm">
                    <Coins size={18} strokeWidth={1.6} aria-hidden />
                  </span>
                  <span className="os-icon-name">{f.symbol}</span>
                  {f.createdByYou && <span className="block text-[11px] text-accent-2-text">created by you</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-border px-3 py-2 text-xs">
        {selected ? (
          <>
            <span className="min-w-0 flex-1 truncate">
              {selected.symbol}
              {selected.balance !== null && ` · ${formatUnits(selected.balance, selected.decimals)}`}
            </span>
            <button type="button" className="rounded-md border border-border-2 px-2 py-1" onClick={() => open("inspector", { token: selected.address })}>Inspect</button>
            <button type="button" className="rounded-md border border-border-2 px-2 py-1" onClick={() => open("drop", { token: selected.address, symbol: selected.symbol, decimals: String(selected.decimals) })}>Send with Drop</button>
            <a className="text-accent-text" href={explorerUrl("token", selected.address)} target="_blank" rel="noreferrer">Explorer</a>
          </>
        ) : (
          <span className="text-muted">Drag a token onto Inspector or Drop. Double-click to inspect.</span>
        )}
      </div>
    </div>
  );
}

export default function FinderWindow() {
  return (
    <ConnectGate>
      <Files />
    </ConnectGate>
  );
}
