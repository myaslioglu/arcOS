"use client";

import { useAccount, useSwitchChain } from "wagmi";
import { BaseError, UserRejectedRequestError } from "viem";
import { activeChain } from "@arcos/chain";

/** Walks an error's `cause` chain (viem's own `BaseError.cause` and the standard `Error.cause`
 * both use this shape) looking for a user rejection: viem's own `UserRejectedRequestError`, or the
 * raw EIP-1193 code 4001 a wallet sends before viem gets a chance to wrap it. */
function isUserRejection(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (current instanceof UserRejectedRequestError) return true;
    if ((current as { code?: unknown }).code === 4001) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Maps a `switchChain` failure to copy the user can act on. A refused switch (the wallet's own
 * "add network" dialog dismissed) reads as a rejection; anything else shows the wallet's own short
 * message. */
export function switchNetworkErrorMessage(error: unknown, chainName: string): string {
  if (isUserRejection(error)) {
    return `Your wallet didn't switch networks. Try again, or add ${chainName} in your wallet.`;
  }
  if (error instanceof BaseError) return error.shortMessage;
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong switching networks.";
}

export type ArcNetworkState = {
  chain: ReturnType<typeof activeChain>;
  /** Connected and on Arc. */
  onArc: boolean;
  /** Connected but on some other chain. */
  wrongNetwork: boolean;
  switching: boolean;
  /** Copy to show when the last switch attempt failed, else null. */
  switchError: string | null;
  switchToArc: () => void;
};

/** One place for "is the wallet on Arc" and "switch it there", so ConnectGate, StatusBar and the
 * Wallet window show the same state and the same error instead of each calling `switchChain` and
 * discarding whatever it throws. */
export function useArcNetwork(): ArcNetworkState {
  const chain = activeChain();
  const { isConnected, chainId } = useAccount();
  const { switchChain, isPending, error } = useSwitchChain();

  return {
    chain,
    onArc: isConnected && chainId === chain.id,
    wrongNetwork: isConnected && chainId !== chain.id,
    switching: isPending,
    switchError: error ? switchNetworkErrorMessage(error, chain.name) : null,
    switchToArc: () => switchChain({ chainId: chain.id }),
  };
}
