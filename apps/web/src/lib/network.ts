"use client";

import { useAccount, useSwitchChain } from "wagmi";
import { SwitchChainError, UserRejectedRequestError } from "viem";
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

/** True for a `cause`-chain node that IS a viem `SwitchChainError` — matched by `instanceof`, or by
 * `.name` for a plain mocked/serialized shape in a test. Its own `.code` is 4902 BY CONSTRUCTION:
 * viem's `RpcError` base class hardcodes the subclass's static code onto the instance unless the
 * cause handed to it is itself a raw `RpcRequestError` (node_modules/viem/errors/rpc.ts). wagmi wraps
 * EVERY non-rejection `switchChain` failure in one of these, so trusting that outer code — as
 * `errorCode` used to — reads almost any failure (a request already open, a transport hiccup,
 * anything) as "chain not added". `errorCode` below skips this node and keeps walking into its
 * `.cause`, where the real code, if there is one, actually lives. */
function isSwitchChainError(error: unknown): boolean {
  if (error instanceof SwitchChainError) return true;
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "SwitchChainError";
}

/** Same cause-chain walk as `isUserRejection`, looking for a numeric EIP-1193 error code instead —
 * viem's own RPC error classes (e.g. `ResourceUnavailableRpcError`) carry one, and so can the
 * wallet's raw, unwrapped error. A `SwitchChainError` node is skipped rather than read (see
 * `isSwitchChainError`) since its own code is always 4902 regardless of what actually went wrong.
 * Used to recognize the small set of switch-chain/connect failures this app has a specific sentence
 * for, without ever falling back to the error's own (possibly raw, provider- or transport-authored)
 * message text. */
function errorCode(error: unknown): number | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (!isSwitchChainError(current)) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "number") return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Shown for both a switch and a connect failure whose code is -32002: the wallet already has a
 * request open (its own "add network" or "connect" dialog, from an earlier click). Factored out so
 * `switchNetworkErrorMessage` and `connectErrorMessage` can't drift into two different sentences for
 * the same wallet state. */
export const ALREADY_OPEN_MESSAGE = "Your wallet already has a request open. Check your wallet and try again.";

/**
 * Maps a `switchChain` failure to copy the user can act on — never the wallet/RPC/transport's own
 * error text, which can carry internal detail or a URL (see lib/contract-error.ts's
 * GENERIC_TRANSACTION_ERROR for the same rule elsewhere). A refused switch (the wallet's own "add
 * network" dialog dismissed) reads as a rejection; code 4902 means the wallet doesn't have the chain
 * added yet; code -32002 means the wallet already has a request open. Anything else — an
 * unrecognized code, or no code at all — gets one generic sentence.
 */
export function switchNetworkErrorMessage(error: unknown, chainName: string): string {
  if (isUserRejection(error)) {
    return `Your wallet didn't switch networks. Try again, or add ${chainName} in your wallet.`;
  }
  const code = errorCode(error);
  if (code === 4902) return `${chainName} isn't added to your wallet yet. Add it in your wallet and try again.`;
  if (code === -32002) return ALREADY_OPEN_MESSAGE;
  return "Something went wrong switching networks.";
}

/**
 * Maps a `connect` failure (wagmi's `useConnect`) to copy the user can act on — same
 * never-the-wallet's-own-text rule as `switchNetworkErrorMessage` above: `useConnect` surfaces
 * whatever the connector/wallet throws, unwrapped, and that can carry internal detail or a URL. A
 * refused connection reads as a rejection; code -32002 means the wallet already has a request open
 * (its own connect dialog from an earlier click). Anything else — an unrecognized code, a transport
 * error, no code at all — gets one generic sentence, never the underlying error's own message.
 */
export function connectErrorMessage(error: unknown): string {
  if (isUserRejection(error)) return "You cancelled the request in your wallet.";
  if (errorCode(error) === -32002) return ALREADY_OPEN_MESSAGE;
  return "Your wallet couldn't connect. Try again.";
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
