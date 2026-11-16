"use client";

import { useSyncExternalStore } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useConnection, usePublicClient, useWriteContract } from "wagmi";
import type { Address, Hex, PublicClient } from "viem";
import { FEE_KEYS, POSITION_MANAGERS, activeChain, activeNetwork, feeControllerAbi, vaultFactoryAbi } from "@arcos/chain";
import { shortAddress } from "@/lib/format";
import { kindOf, readPosition, type AllowedManager, type Position } from "@/lib/positions";
import { clientReads, ok } from "@/lib/reads";
import { chainNow, type ClockSample } from "./clock";
import { asPending, type LockFees } from "./fees";
import type { FlowClient, FlowDeps } from "./flow";
import { loadLocks, type LocksAnswer } from "./locks";
import { aggregate3, readTokenInfo, type TokenInfo } from "./tokenInfo";

/** The query keys Vault's reads share, so a finished transaction can ask each to read again. */
export const LOCKS_KEY = "vault-locks";
export const TOKEN_KEY = "vault-token";

const CLOCK_TICK_MS = 15_000;
const subscribeTick = (onTick: () => void) => {
  const id = setInterval(onTick, CLOCK_TICK_MS);
  return () => clearInterval(id);
};
const tickSnapshot = () => Math.floor(Date.now() / CLOCK_TICK_MS) * CLOCK_TICK_MS;
const serverTick = () => 0;

/**
 * The chain's time (clock.ts): the latest block's timestamp, read every 30 s, plus the time since, moving on every 15
 * s. `at(ms)` is the chain's time at a precise local moment, for a check made when a button is pressed. Until the
 * block has been read, and if it can't be, the local clock stands in.
 */
export function useChainClock(): { now: number; fromChain: boolean; at: (ms: number) => number } {
  const chain = activeChain();
  const client = usePublicClient({ chainId: chain.id });
  const sample = useQuery<ClockSample>({
    queryKey: ["vault-clock", chain.id],
    enabled: !!client,
    refetchInterval: 30_000,
    queryFn: async () => {
      const block = await client!.getBlock({ blockTag: "latest" });
      return { chain: Number(block.timestamp), at: Date.now() };
    },
  });
  const tick = useSyncExternalStore(subscribeTick, tickSnapshot, serverTick);
  const data = sample.data;
  return {
    now: chainNow(data, data ? Math.max(tick, data.at) : tick),
    fromChain: !!data,
    at: (ms: number) => chainNow(data, ms),
  };
}

/**
 * The three lock fees, from the factory's own FeeController, with any raise it has scheduled for each (`pendingOf`).
 * The lock itself reads the fees again before the wallet opens (flow.ts), so this read is what the form shows.
 */
export function useLockFees(factory: Address | null) {
  const chain = activeChain();
  const client = usePublicClient({ chainId: chain.id });
  return useQuery<LockFees>({
    queryKey: ["vault-fees", chain.id, factory],
    enabled: !!factory && !!client,
    refetchInterval: 60_000,
    queryFn: async () => {
      const feeController = (await client!.readContract({ address: factory!, abi: vaultFactoryAbi, functionName: "feeController" })) as Address;
      const fee = (key: Hex) => client!.readContract({ address: feeController, abi: feeControllerAbi, functionName: "feeOf", args: [key] }) as Promise<bigint>;
      // A raise that can't be read is left unsaid rather than holding the form back: the lock checks the fees anyway.
      const pending = (key: Hex) =>
        client!.readContract({ address: feeController, abi: feeControllerAbi, functionName: "pendingOf", args: [key] }).then(asPending, () => null);
      const keys = [FEE_KEYS.LOCK_FLAT, FEE_KEYS.LOCK_LP_BPS, FEE_KEYS.LOCK_FEE_SHARE_BPS] as const;
      const [[flat, lpBps, shareBps], [pFlat, pLp, pShare]] = await Promise.all([Promise.all(keys.map(fee)), Promise.all(keys.map(pending))]);
      return { feeController, flat: flat!, lpBps: lpBps!, shareBps: shareBps!, pending: { flat: pFlat ?? null, lpBps: pLp ?? null, shareBps: pShare ?? null } };
    },
  });
}

/** A token's details for the form (tokenInfo.ts), or nothing until a whole address is typed. */
export function useTokenInfo(token: Address | null, owner: Address | undefined, factory: Address | null) {
  const chain = activeChain();
  const client = usePublicClient({ chainId: chain.id });
  return useQuery<TokenInfo | { error: string }>({
    queryKey: [TOKEN_KEY, chain.id, token?.toLowerCase(), owner?.toLowerCase(), factory],
    enabled: !!token && !!owner && !!factory && !!client,
    retry: false,
    refetchInterval: 30_000,
    queryFn: () =>
      readTokenInfo(token!, {
        read: clientReads(client! as PublicClient).read,
        rawCalls: aggregate3((args) => client!.readContract(args as never)),
        getCode: (address) => client!.getCode({ address }),
        owner: owner!,
        factory: factory!,
      }),
  });
}

/** A position typed in or dropped: whether the factory takes its manager (and as what kind), and the position. */
export type PositionInfo = { manager: AllowedManager | null; position: Position | "not-yours" | null };

export function usePositionInfo(manager: Address | null, tokenId: bigint | null, owner: Address | undefined, factory: Address | null) {
  const chain = activeChain();
  const network = activeNetwork();
  const client = usePublicClient({ chainId: chain.id });
  return useQuery<PositionInfo>({
    queryKey: ["vault-position", chain.id, factory, manager?.toLowerCase(), tokenId?.toString(), owner?.toLowerCase()],
    enabled: !!manager && tokenId !== null && !!owner && !!factory && !!client,
    retry: false,
    queryFn: async () => {
      const { read } = clientReads(client! as PublicClient);
      const [answer] = await read([{ address: factory!, abi: vaultFactoryAbi, functionName: "managers", args: [manager!] }]);
      const allowed = ok(answer);
      const kind = Array.isArray(allowed) && allowed[0] === true ? kindOf(allowed[1]) : null;
      if (!kind) return { manager: null, position: null };
      const name = POSITION_MANAGERS[network].find((m) => m.address.toLowerCase() === manager!.toLowerCase())?.name ?? `Manager ${shortAddress(manager!)}`;
      const m: AllowedManager = { address: manager!, name, kind };
      return { manager: m, position: await readPosition(read, m, tokenId!, owner!) };
    },
  });
}

/** The wallet's locks (locks.ts): `extra` is the vaults read besides the registry's, `pages` how many registry pages. */
export function useLocks(wallet: Address | undefined, factory: Address | null, extra: readonly Address[], pages: number) {
  const chain = activeChain();
  const network = activeNetwork();
  const client = usePublicClient({ chainId: chain.id });
  return useQuery<LocksAnswer>({
    queryKey: [LOCKS_KEY, network, factory, wallet?.toLowerCase(), [...extra].map((a) => a.toLowerCase()).sort().join(","), pages],
    enabled: !!wallet && !!factory && !!client,
    retry: false,
    refetchInterval: 30_000,
    // Opening another vault or reading another page keeps the list on screen while the new one is read.
    placeholderData: keepPreviousData,
    queryFn: () => loadLocks({ ...clientReads(client! as PublicClient), factory: factory!, wallet: wallet!, extra, pages, managers: POSITION_MANAGERS[network] }),
  });
}

/**
 * What the flows need to send (flow.ts), or null with no wallet. The one place Vault hands wagmi's write on.
 */
export function useFlowDeps(): FlowDeps | null {
  const chain = activeChain();
  const { address, chainId: walletChainId } = useConnection();
  const client = usePublicClient({ chainId: chain.id });
  const writeContract = useWriteContract();
  if (!client || !address) return null;
  return {
    client: client as unknown as FlowClient,
    account: address,
    chainId: chain.id,
    walletChainId,
    // Passed by reference, not called here: flow.ts makes the calls, `deps.writeContractAsync(withChain(...))`, and the
    // paid-write scan (lib/__tests__/paid-write.test.ts) checks them there, by that name. This reference is the scan's
    // one ALLOWLIST entry for this file; a second one fails it.
    writeContractAsync: writeContract.mutateAsync as (request: never) => Promise<Hex>,
  };
}
