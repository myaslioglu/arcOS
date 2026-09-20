import { defineChain, type Chain } from "viem";
import { arc, arcTestnet } from "viem/chains";

export type NetworkId = "mainnet" | "testnet";

/**
 * viem 2.56 still ships the pre-launch testnet hosts (rpc.testnet.arc.network,
 * testnet.arcscan.app). The documented ones are on arc.io.
 */
const testnet = defineChain({
  ...arcTestnet,
  rpcUrls: {
    default: {
      http: [
        "https://rpc.testnet.arc.io",
        "https://rpc.drpc.testnet.arc.io",
        "https://rpc.quicknode.testnet.arc.io",
      ],
      webSocket: ["wss://rpc.testnet.arc.io"],
    },
  },
  blockExplorers: {
    default: {
      name: "Arc Explorer",
      url: "https://explorer.testnet.arc.io",
      apiUrl: "https://explorer.testnet.arc.io/api/v2",
    },
  },
});

export const CHAINS: Record<NetworkId, Chain> = { mainnet: arc, testnet };

/** Testnet unless the environment says exactly "mainnet". */
export function activeNetwork(): NetworkId {
  return process.env.NEXT_PUBLIC_ARC_NETWORK === "mainnet" ? "mainnet" : "testnet";
}

export function activeChain(): Chain {
  return CHAINS[activeNetwork()];
}

export function explorerUrl(
  kind: "address" | "tx" | "token",
  value: string,
  network: NetworkId = activeNetwork(),
): string {
  const base = CHAINS[network].blockExplorers?.default.url ?? "";
  return `${base}/${kind}/${value}`;
}
