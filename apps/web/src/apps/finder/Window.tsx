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
import { shortAddress } from "@/lib/format";
import { duplicateSymbols, latestSliceStart, mergeTokens, officialSymbol, type TokenFile } from "./tokens";

/** Page size for `tokensOfSlice`: Finder only ever shows the creator's most recent tokens. */
const CREATED_PAGE_SIZE = 100;

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

  // "Created by you" pages through the registry (tokenCountOf + tokensOfSlice) instead of tokensOf, which
  // copies the whole per-creator array — unbounded for a heavy creator. Only the latest CREATED_PAGE_SIZE
  // tokens are shown here.
  const createdCount = useReadContract({
    address: factory,
    abi: tokenFactoryAbi,
    functionName: "tokenCountOf",
    args: address ? [address] : undefined,
    chainId: chain.id,
    query: { enabled: !!address && !!factory, refetchInterval: 15_000 },
  });
  const count = (createdCount.data ?? 0n) as bigint;
  const sliceStart = useMemo(() => latestSliceStart(count, CREATED_PAGE_SIZE), [count]);

  const created = useReadContract({
    address: factory,
    abi: tokenFactoryAbi,
    functionName: "tokensOfSlice",
    args: address ? [address, sliceStart, BigInt(CREATED_PAGE_SIZE)] : undefined,
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

  const dupes = useMemo(() => duplicateSymbols(files), [files]);
  const stillReading = holdings.isLoading || createdCount.isLoading || created.isLoading;

  return (
    <div className="flex h-full flex-col text-sm">
      {holdings.isError && (
        <p className="border-b border-border px-4 py-2 text-xs text-muted">
          {"The explorer didn't answer, so only tokens you created here are listed."}
        </p>
      )}
      {count > BigInt(CREATED_PAGE_SIZE) && (
        <p className="border-b border-border px-4 py-2 text-xs text-muted">
          {`Showing your latest ${CREATED_PAGE_SIZE} of ${count} tokens.`}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {files.length === 0 ? (
          <p className="p-3 text-muted">{stillReading ? "Reading your tokens…" : "No tokens yet. Create one in Mint, or receive some."}</p>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(128px,1fr))] gap-1">
            {files.map((f) => {
              const official = officialSymbol(f.address, network);
              const collides = dupes.has(f.symbol.trim().toLowerCase());
              return (
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
                    <span className="block font-mono text-[10px] text-muted">{shortAddress(f.address)}</span>
                    {f.createdByYou && <span className="block text-[11px] text-accent-2-text">created by you</span>}
                    {official && <span className="block text-[11px] text-accent-2-text">Official {official}</span>}
                    {collides && <span className="block text-[11px] text-accent-3-text">Same symbol as another token</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-border px-3 py-2 text-xs">
        {selected ? (
          <>
            <span className="min-w-0 flex-1 truncate">
              {selected.symbol} · <span className="font-mono text-muted">{shortAddress(selected.address)}</span>
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
