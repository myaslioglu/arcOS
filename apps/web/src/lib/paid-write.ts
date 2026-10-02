import { UserFacingError } from "./contract-error";

/**
 * The single choke point every paid on-chain write (Mint's `createToken`, Drop's `approve` /
 * `sendToken` / `sendNative`, Revoke's revokes) must pass through before reaching wagmi's write
 * (`useWriteContract`'s `mutateAsync`).
 *
 * Why this matters (read both files before touching either): wagmi 3's `writeContract` action
 * (`node_modules/wagmi/node_modules/@wagmi/core/src/actions/writeContract.ts`, which `useWriteContract`'s
 * `mutateAsync` runs) takes the connector's client without checking its chain (`assertChainId: false`), then
 * calls viem's `writeContract` with `assertChainId: !!chainId`, and with `chain` set to the wallet's own
 * chain when no `chainId` is given. viem's `sendTransaction`
 * (`node_modules/viem/_esm/actions/wallet/sendTransaction.js`) runs `assertCurrentChain` — the check that
 * refuses to sign when the wallet's connected chain doesn't match — only when `assertChainId` is true.
 * Calling `mutateAsync(request)` with no `chainId` therefore skips the assertion and signs on whatever
 * network the wallet is on, so a wallet on the wrong network (or one that switched between render and
 * click) signs and broadcasts there instead of refusing — silently sending `value` (real USDC, native
 * 18-decimal) on a chain that has no code at the target address. That is exactly the regression wave C
 * introduced (see the wave E brief, item C1) and exactly what this helper exists to make impossible to
 * repeat: every call site is checked by a source-text scan in __tests__/paid-write.test.ts, which fails if
 * a future write call doesn't route through `withChain`.
 *
 * `simulateContract`'s returned `request` may or may not already carry a `chainId`, depending on how
 * it was called — this always sets it explicitly rather than trusting whatever `request` happened to
 * have, and throws instead of silently sending `chainId: undefined` if the caller couldn't resolve one.
 */
export function withChain<T extends object>(request: T, chainId: number | undefined): T & { chainId: number } {
  if (chainId === undefined) throw new Error("withChain: chainId is required for a paid write");
  return { ...request, chainId };
}

/**
 * Defence in depth, not the real guard — `withChain` (above) is: `chainId` on the write is what makes
 * viem refuse to sign on the wrong chain. This runs earlier, before the wallet even opens, so a wallet
 * that's on the wrong network gets one plain sentence instead of a simulate call against Arc's public
 * client succeeding (it's a read against a fixed RPC, not the wallet) followed by a cryptic
 * chain-mismatch error from the wallet itself. Throws a `UserFacingError` — never a plain Error — so
 * `describeContractError` returns this sentence verbatim rather than its generic fallback.
 */
export function assertWalletOnChain(walletChainId: number | undefined, expectedChainId: number): void {
  if (walletChainId !== expectedChainId) {
    throw new UserFacingError("Your wallet is on a different network. Switch to Arc and try again.");
  }
}
