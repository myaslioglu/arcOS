"use client";

import { useQuery } from "@tanstack/react-query";
import { useConnection } from "wagmi";
import { createPublicClient, erc20Abi, fallback, http } from "viem";
import { ARC_CHAIN_NAME } from "@/lib/appkit";
import { useArcTokenBalance } from "@/lib/useArcTokenBalance";
import { bridgeChainInfo, type ChainId } from "./chains";

/** How often the other chain's balance is read again, the same as the top bar's. */
const REFETCH_MS = 15_000;

/**
 * The connected wallet's USDC on a bridge's source chain, in 6-decimal units, or undefined while there is no wallet, while
 * it loads, or when the read failed.
 *
 * On Arc it is the top bar's balance (`useArcTokenBalance`, through wagmi). The other chains are in the wagmi config only
 * so a WalletConnect session covers them (lib/wallet-chains.ts); their balance is read without wagmi, as an ERC-20
 * `balanceOf` through the same public RPC endpoints App Kit's adapter uses for that chain, from App Kit's own chain
 * definition: the bridge itself checks this very balance there before it asks the wallet for anything.
 */
export function useSourceBalance(source: ChainId): bigint | undefined {
  const { address } = useConnection();
  const onArc = source === ARC_CHAIN_NAME;
  const arc = useArcTokenBalance("USDC");
  const info = onArc ? null : bridgeChainInfo(source);

  const other = useQuery({
    queryKey: ["bridge-source-balance", source, address],
    enabled: !!address && info !== null,
    refetchInterval: REFETCH_MS,
    retry: 1,
    queryFn: async () => {
      const client = createPublicClient({ transport: fallback(info!.rpcEndpoints.map((url) => http(url))) });
      return client.readContract({ address: info!.usdcAddress, abi: erc20Abi, functionName: "balanceOf", args: [address!] });
    },
  });

  if (!address) return undefined;
  return onArc ? arc.units : other.data;
}

