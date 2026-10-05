import { defineChain, type Chain } from "viem";
import {
  arbitrum,
  arbitrumSepolia,
  avalanche,
  avalancheFuji,
  base,
  baseSepolia,
  mainnet,
  optimism,
  optimismSepolia,
  polygon,
  polygonAmoy,
  sepolia,
} from "viem/chains";
import {
  Arbitrum,
  ArbitrumSepolia,
  Avalanche,
  AvalancheFuji,
  Base,
  BaseSepolia,
  Ethereum,
  EthereumSepolia,
  Optimism,
  OptimismSepolia,
  Polygon,
  PolygonAmoy,
} from "@circle-fin/app-kit/chains";
import { CHAINS, activeNetwork, type NetworkId } from "@arcos/chain";

/**
 * The chains a wallet session covers, for providers/wagmi.ts.
 *
 * Arc is where every app signs, so it comes first: wallets are asked to connect on the first chain. The chains Bridge
 * offers on the other side of Arc (apps/bridge/chains.ts) follow, for one reason: a WalletConnect session only lets the
 * page switch to a chain the session was opened with. wagmi's walletConnect connector builds that list from the config's
 * `chains` and nothing else (`optionalChains` in @wagmi/connectors' walletConnect.js, both in getProvider and in connect).
 * Without them, Bridge's mint on the destination chain asks the phone's wallet for `wallet_switchEthereumChain` to a
 * chain outside the session: WalletConnect's provider forwards such a request to the wallet (universal-provider's
 * `handleSwitchChain`), and Trust Wallet answered one by closing (2026-10-03, a burn on Arc whose mint on Base never
 * ran). For a chain inside the session the same request is answered by the provider itself, with no round trip to the
 * phone, and the transaction that follows is signed on that chain.
 *
 * Each destination chain is viem's own definition with its RPC endpoints replaced by App Kit's for that chain: those
 * are the hosts the site's connect-src already lists (lib/security-headers.ts, `CIRCLE_CONNECT`), since the kit's
 * adapter reads the chain through them; viem's defaults (ethereum.reth.rs, 11155111.rpc.thirdweb.com, ...) are not.
 * wagmi's `http()` transport and the WalletConnect provider's `rpcMap` both take the first of them.
 *
 * Adding a chain here changes what an existing WalletConnect session is checked against: wagmi's connector reads the
 * chains it asked for last time (`requestedChainsIds`) and treats a session that lacks a configured chain as stale, so
 * such a session is dropped on the next reload and the visitor pairs again, this time with every chain in the session.
 */

type KitDefinition = { chain: string; chainId: number; rpcEndpoints: readonly string[] };

/** One destination chain: App Kit's definition (the bridge id and RPC hosts) and viem's (what wagmi wants). */
export type DestinationChain = { kit: KitDefinition; viem: Chain };

const MAINNET: DestinationChain[] = [
  { kit: Ethereum, viem: mainnet },
  { kit: Base, viem: base },
  { kit: Arbitrum, viem: arbitrum },
  { kit: Optimism, viem: optimism },
  { kit: Polygon, viem: polygon },
  { kit: Avalanche, viem: avalanche },
];

const TESTNET: DestinationChain[] = [
  { kit: EthereumSepolia, viem: sepolia },
  { kit: BaseSepolia, viem: baseSepolia },
  { kit: ArbitrumSepolia, viem: arbitrumSepolia },
  { kit: OptimismSepolia, viem: optimismSepolia },
  { kit: PolygonAmoy, viem: polygonAmoy },
  { kit: AvalancheFuji, viem: avalancheFuji },
];

/** The pairs for one network, each checked to be the same chain under both names. */
export function destinationChains(network: NetworkId): DestinationChain[] {
  const pairs = network === "mainnet" ? MAINNET : TESTNET;
  for (const { kit, viem } of pairs) {
    if (kit.chainId !== viem.id) throw new Error(`wallet-chains: ${kit.chain} is chain ${kit.chainId} to App Kit but ${viem.id} to viem`);
  }
  return pairs;
}

/** viem's chain with App Kit's RPC endpoints for it (see the module comment). */
function withKitRpc({ kit, viem }: DestinationChain): Chain {
  return defineChain({ ...viem, rpcUrls: { default: { http: [...kit.rpcEndpoints] } } });
}

/**
 * The wagmi config's chain list for a network: that network's Arc first, the other network's Arc (so a wallet on the
 * wrong Arc is still a known chain), then the chains Bridge offers on that network.
 */
export function walletChains(network: NetworkId = activeNetwork()): readonly [Chain, Chain, ...Chain[]] {
  const other: NetworkId = network === "mainnet" ? "testnet" : "mainnet";
  return [CHAINS[network], CHAINS[other], ...destinationChains(network).map(withKitRpc)];
}
