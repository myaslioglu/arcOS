import type { QueryClient } from "@tanstack/react-query";

/**
 * One mechanism for "my balance may have changed": an app that has just sent (or may have sent) a transaction calls
 * `notifyBalanceChanged()`, and the top bar, which is always mounted, invalidates every wagmi balance read (`balance`
 * for native USDC, `readContract` for ERC-20 `balanceOf`) so the menu bar, Wallet and the amount boxes' balance lines
 * all re-read. A plain function, so it also works from the apps' module-level sessions and flows.
 */
type Listener = () => void;
const listeners = new Set<Listener>();

export function notifyBalanceChanged(): void {
  for (const fn of [...listeners]) fn();
}

export function onBalanceChanged(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The wagmi query keys that hold balances (see @wagmi/core's getBalanceQueryKey and readContractQueryKey). */
export const BALANCE_QUERY_KEYS = ["balance", "readContract"] as const;

export function invalidateBalances(queryClient: Pick<QueryClient, "invalidateQueries">): void {
  for (const key of BALANCE_QUERY_KEYS) void queryClient.invalidateQueries({ queryKey: [key] });
}

/** Wires `notifyBalanceChanged` to the query client; the second pass covers an RPC node still a block behind. */
export function watchBalanceChanges(queryClient: Pick<QueryClient, "invalidateQueries">, delayMs = 4_000): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const off = onBalanceChanged(() => {
    invalidateBalances(queryClient);
    clearTimeout(timer);
    timer = setTimeout(() => invalidateBalances(queryClient), delayMs);
  });
  return () => {
    off();
    clearTimeout(timer);
  };
}
