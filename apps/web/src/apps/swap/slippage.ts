import type { SwapToken } from "./tokenPair";

/** Used for a USDC/EURC pair — two tightly-pegged stablecoins with deep liquidity. */
export const STABLE_SLIPPAGE_BPS = 50;
/** Used whenever cirBTC is on either side of the pair — thinner liquidity and wider spreads than
 * the stablecoin pair, so it gets double the tolerance. */
export const CIRBTC_SLIPPAGE_BPS = 100;

/**
 * An explicit `slippageBps` for every pair Swap offers, instead of inheriting the SDK's own
 * `SwapConfig` default of 300 bps (3%) — too loose for a same-chain stablecoin swap on Arc. See
 * node_modules/@circle-fin/app-kit/index.d.ts ~line 17900: "Defaults to 300 BPS (3%)."
 */
export function slippageBpsFor(tokenIn: SwapToken, tokenOut: SwapToken): number {
  return tokenIn === "cirBTC" || tokenOut === "cirBTC" ? CIRBTC_SLIPPAGE_BPS : STABLE_SLIPPAGE_BPS;
}

/** Basis points → a trimmed percentage string: "50" -> "0.5%", "100" -> "1%". Unlike the platform
 * fee's fixed two-decimal label (lib/appkit.ts's feePercentLabel), a trailing ".0" is dropped here
 * since both slippage values Swap actually uses (50 and 100 bps) are round to one decimal place. */
export function slippagePercentLabel(bps: number): string {
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}
