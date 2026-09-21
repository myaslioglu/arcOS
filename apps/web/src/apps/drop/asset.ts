import { getAddress, isAddress } from "viem";
import type { Address } from "@arcos/chain";

/**
 * What a Drop send will actually move, as an explicit discriminated value — replacing the old
 * convention where `token: Address | null` used `null` to mean BOTH "send native USDC" and "no
 * token resolved yet". That conflation was a pre-existing fund-safety hazard (wave G, N8): with
 * "Another token" selected and the address field empty or still being typed, `token` was `null`,
 * which `useDrop.ts` read as "send native" — so clicking Send before finishing the address sent
 * real native USDC instead of refusing. `unresolved` covers both "no valid address entered yet"
 * and "a valid address was entered but its symbol/decimals are still loading or failed to read" —
 * `canSend.ts` tells those two apart for its own wording via a separate flag, since neither is
 * safe to send from either way.
 */
export type DropAsset =
  | { kind: "native" }
  | { kind: "token"; address: Address; decimals: number; symbol: string }
  | { kind: "unresolved" };

export type DropAssetInput = {
  mode: "usdc" | "token";
  /** Raw text from the token address field — validated here, not trusted from the caller. */
  tokenAddr: string;
  /** Resolved decimals for `tokenAddr`, once `mode === "token"` and the address is syntactically
   * valid — `null` while still loading or if the read failed. Ignored in "usdc" mode, so a value
   * left over from a previously resolved token can never leak into a native send (the "reverse"
   * case the N8 brief calls out). */
  decimals: number | null;
  /** Resolved symbol, same lifecycle as `decimals`. */
  symbol: string | null;
};

/**
 * The single place that decides native vs. a specific resolved token vs. "not ready to send from
 * yet" — threaded through `canSend.ts` (which refuses while unresolved) and `useDrop.ts`'s `send()`
 * (which reads the two accessors below, so `sendNative` is reachable only once this resolves to
 * `"native"`). `Window.tsx`'s own amount parsing reproduces `dropAssetDecimals`' rule inline rather
 * than calling it, for the React Compiler reason documented at that call site — the two are kept
 * honest by asset.test.ts, which asserts the rule against `resolveDropAsset`'s output.
 */
export function resolveDropAsset(input: DropAssetInput): DropAsset {
  if (input.mode === "usdc") return { kind: "native" };
  if (!isAddress(input.tokenAddr, { strict: false })) return { kind: "unresolved" };
  if (input.decimals === null || input.symbol === null) return { kind: "unresolved" };
  return { kind: "token", address: getAddress(input.tokenAddr), decimals: input.decimals, symbol: input.symbol };
}

/** The decimals to parse/format amounts at for `asset` — `null` (never a default) while
 * unresolved, so an unresolved token's rows are never parsed at the wrong scale, or at all. Used by
 * `useDrop.ts`'s `send()`. */
export function dropAssetDecimals(asset: DropAsset): number | null {
  if (asset.kind === "native") return 6;
  if (asset.kind === "token") return asset.decimals;
  return null;
}

/** The token address `useDrop.ts`'s `send()` moves funds in — `null` for native (the multisend
 * contract's `sendNative` path) or while unresolved (never a guess), the resolved address
 * otherwise. */
export function dropAssetTokenAddress(asset: DropAsset): Address | null {
  return asset.kind === "token" ? asset.address : null;
}
