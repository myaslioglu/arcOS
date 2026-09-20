import { getAddress, isAddress, type EIP1193Provider } from "viem";
import type { Connector } from "wagmi";
import { createViemAdapterFromProvider } from "@circle-fin/adapter-viem-v2";
import { formatUsdc, parseUsdc, activeNetwork, type Address } from "@arcos/chain";

export const ARC_CHAIN_NAME: "Arc" | "Arc_Testnet" = activeNetwork() === "mainnet" ? "Arc" : "Arc_Testnet";
export const SWAP_FEE_BPS = 20;
export const SWAP_TOKENS = ["USDC", "EURC", "cirBTC"] as const;

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
