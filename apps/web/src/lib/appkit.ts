import { getAddress, isAddress, type EIP1193Provider } from "viem";
import type { Connector } from "wagmi";
import { createViemAdapterFromProvider } from "@circle-fin/adapter-viem-v2";
import { formatUsdc, parseUsdc, activeNetwork, type Address } from "@arcos/chain";

export const ARC_CHAIN_NAME: "Arc" | "Arc_Testnet" = activeNetwork() === "mainnet" ? "Arc" : "Arc_Testnet";
export const SWAP_FEE_BPS = 20;
export const SWAP_TOKENS = ["USDC", "EURC", "cirBTC"] as const;

/**
 * Decimal places for each SWAP_TOKENS entry, used to validate and normalize the amount box under
 * the token currently picked.
 *
 * Not resolvable synchronously from the installed SDK: `getTokenDecimals` (exported by
 * @circle-fin/app-kit) is async and needs a live adapter/chain, and `createTokenRegistry`
 * (referenced only in that function's own JSDoc example) isn't in the package's public export list
 * — see node_modules/@circle-fin/app-kit/index.d.ts's closing `export { ... }` statement, which
 * omits it. USDC and EURC are both Circle-issued stablecoins at 6 decimals (confirmed for USDC by
 * the SDK's own `TokenInfo` example, index.d.ts ~line 1271: `{ name: 'USDC', symbol: 'USDC',
 * decimals: 6 }`); cirBTC mirrors Bitcoin's 8-decimal convention, the same precision the SDK's own
 * docs use for the other BTC-pegged token it names, WBTC (index.d.ts ~line 9946: "await
 * getTokenDecimals('WBTC', ...) // 8").
 */
export const SWAP_TOKEN_DECIMALS: Record<(typeof SWAP_TOKENS)[number], number> = {
  USDC: 6,
  EURC: 6,
  cirBTC: 8,
};

/** Basis points → a fixed two-decimal percentage string, e.g. 20 -> "0.20%". */
export function feePercentLabel(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

/** Public address that receives platform fees. No fee is charged when it's missing or malformed. */
export function feeRecipient(): Address | null {
  const raw = process.env.NEXT_PUBLIC_FEE_RECIPIENT ?? "";
  return isAddress(raw, { strict: false }) ? getAddress(raw) : null;
}

/** Bridge fees are absolute amounts: 0.20% of the transfer, floored to 6 decimal places. */
export function bridgeFee(amount: string): string {
  try {
    return formatUsdc((parseUsdc(amount) * BigInt(SWAP_FEE_BPS)) / 10_000n);
  } catch {
    return "0";
  }
}

/** Wraps the active wagmi connector's EIP-1193 provider in a Circle App Kit viem adapter. */
export async function adapterFor(connector: Connector) {
  const provider = (await connector.getProvider()) as EIP1193Provider;
  return createViemAdapterFromProvider({ provider });
}
