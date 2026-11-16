"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { POSITION_MANAGERS, activeChain, activeNetwork, type Address } from "@arcos/chain";
import { allowedManagers, loadPositions, type AllowedManager, type PositionsAnswer } from "./positions";
import { clientReads } from "./reads";

/** How often the list is read again: a position's owner changes only by a transaction, and a lock re-reads it. */
const REFETCH_MS = 60_000;

/** The query key every positions list shares, so a lock in Vault can ask Finder's list to read again. */
export const POSITIONS_KEY = "positions";

/**
 * The wallet's positions in the managers `factory` allows (see positions.ts), or nothing while there is no wallet or
 * no factory. Finder's Positions section and Vault's position picker both read it.
 */
export function usePositions(owner: Address | undefined, factory: Address | null) {
  const chain = activeChain();
  const network = activeNetwork();
  const client = usePublicClient({ chainId: chain.id });
  return useQuery<PositionsAnswer>({
    queryKey: [POSITIONS_KEY, network, factory, owner?.toLowerCase()],
    enabled: !!owner && !!factory && !!client,
    retry: false,
    refetchInterval: REFETCH_MS,
    queryFn: () =>
      loadPositions({
        ...clientReads(client!),
        apiUrl: chain.blockExplorers?.default.apiUrl,
        factory: factory!,
        owner: owner!,
        candidates: POSITION_MANAGERS[network],
      }),
  });
}

/** The known managers `factory` allows, with the kind it gives each: what Vault's position form offers. */
export function useAllowedManagers(factory: Address | null) {
  const chain = activeChain();
  const network = activeNetwork();
  const client = usePublicClient({ chainId: chain.id });
  return useQuery<AllowedManager[]>({
    queryKey: ["allowed-managers", network, factory],
    enabled: !!factory && !!client,
    retry: false,
    staleTime: 5 * 60_000,
    queryFn: () => allowedManagers(clientReads(client!).read, factory!, POSITION_MANAGERS[network]),
  });
}
