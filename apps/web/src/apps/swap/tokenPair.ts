import type { SWAP_TOKENS } from "@/lib/appkit";

export type SwapToken = (typeof SWAP_TOKENS)[number];
export type TokenPair = { tokenIn: SwapToken; tokenOut: SwapToken };

/**
 * Applies a pick on one side of the pair. Picking the token already on the other side swaps the
 * pair instead of producing tokenIn === tokenOut — the token pickers can never select the same
 * token twice.
 */
export function pickToken(pair: TokenPair, side: "in" | "out", picked: SwapToken): TokenPair {
  if (side === "in") {
    return picked === pair.tokenOut ? { tokenIn: picked, tokenOut: pair.tokenIn } : { tokenIn: picked, tokenOut: pair.tokenOut };
  }
  return picked === pair.tokenIn ? { tokenIn: pair.tokenOut, tokenOut: picked } : { tokenIn: pair.tokenIn, tokenOut: picked };
}

export function flipTokens(pair: TokenPair): TokenPair {
  return { tokenIn: pair.tokenOut, tokenOut: pair.tokenIn };
}
