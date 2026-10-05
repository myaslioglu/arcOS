"use client";

import { useBalance, useConnection, useReadContract } from "wagmi";
import { erc20Abi } from "viem";
import { CIRBTC, EURC, activeChain, activeNetwork, nativeToUnits, type Address } from "@arcos/chain";
import { SWAP_TOKEN_DECIMALS, type SWAP_TOKENS } from "./appkit";

export type ArcToken = (typeof SWAP_TOKENS)[number];

/** Where each ERC-20 token Swap offers lives on the active network. USDC is Arc's native token and is read natively. */
const TOKEN_ADDRESS: Record<Exclude<ArcToken, "USDC">, Address> = {
  EURC: EURC[activeNetwork()],
  cirBTC: CIRBTC[activeNetwork()],
};

/** How often a balance is read again, the same as the top bar's. */
const REFETCH_MS = 15_000;

/**
 * The connected wallet's balance of one of Swap's tokens on Arc, in the token's own units (6 decimals for USDC and EURC,
 * 8 for cirBTC), or undefined while there is no wallet, while it loads, or when the read failed.
 *
 * USDC is read the way the top bar reads it (`useBalance`, Arc's native balance in 18-decimal wei), then floored to its
 * 6-decimal ERC-20 units, which is what the swap actually spends. The others are an ERC-20 `balanceOf`. Both reads are
 * declared on every render (hooks can't be conditional) and only the one the token needs is enabled.
 */
export function useArcTokenBalance(token: ArcToken): { units: bigint | undefined; decimals: number } {
  const { address } = useConnection();
  const chainId = activeChain().id;
  const isNative = token === "USDC";

  const native = useBalance({ address, chainId, query: { enabled: !!address && isNative, refetchInterval: REFETCH_MS } });
  const erc20 = useReadContract({
    address: isNative ? undefined : TOKEN_ADDRESS[token],
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId,
    query: { enabled: !!address && !isNative, refetchInterval: REFETCH_MS },
  });

  const decimals = SWAP_TOKEN_DECIMALS[token];
  if (!address) return { units: undefined, decimals };
  if (isNative) return { units: native.data ? nativeToUnits(native.data.value).units : undefined, decimals };
  return { units: typeof erc20.data === "bigint" ? erc20.data : undefined, decimals };
}
