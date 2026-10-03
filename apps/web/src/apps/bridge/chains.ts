import type { BridgeChain } from "@circle-fin/app-kit";
import {
  Arbitrum,
  ArbitrumSepolia,
  Arc,
  ArcTestnet,
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
import { activeNetwork, type Address } from "@arcos/chain";

/** `BridgeChainIdentifier` (what `BridgeParams` actually wants) isn't exported by the package —
 * this is the same shape restricted to the string-literal form, built from the exported enum. */
export type ChainId = `${BridgeChain}`;

export type EvmChainOption = { chain: ChainId; label: string };

/**
 * EVM chains only — Solana needs a second, non-EVM wallet adapter this app doesn't have, so it's
 * left out of R0 even though the SDK's BridgeChain enum includes it. Identifiers are the exact
 * string literals the installed `BridgeChain` enum uses (verified against
 * node_modules/@circle-fin/app-kit's types before writing this list).
 */
const MAINNET: EvmChainOption[] = [
  { chain: "Ethereum", label: "Ethereum" },
  { chain: "Base", label: "Base" },
  { chain: "Arbitrum", label: "Arbitrum" },
  { chain: "Optimism", label: "Optimism" },
  { chain: "Polygon", label: "Polygon" },
  { chain: "Avalanche", label: "Avalanche" },
];

const TESTNET: EvmChainOption[] = [
  { chain: "Ethereum_Sepolia", label: "Ethereum Sepolia" },
  { chain: "Base_Sepolia", label: "Base Sepolia" },
  { chain: "Arbitrum_Sepolia", label: "Arbitrum Sepolia" },
  { chain: "Optimism_Sepolia", label: "Optimism Sepolia" },
  { chain: "Polygon_Amoy_Testnet", label: "Polygon Amoy" },
  { chain: "Avalanche_Fuji", label: "Avalanche Fuji" },
];

/** The chains Bridge offers on "the other side" of Arc, matching the active network so a testnet
 * session never lists a mainnet chain (or the reverse). */
export function bridgeChainOptions(): EvmChainOption[] {
  return activeNetwork() === "mainnet" ? MAINNET : TESTNET;
}

/** A chain people look for in Bridge that it can't offer, shown greyed out in the picker with the reason. */
export type UnsupportedChainOption = { label: string; note: string };

/**
 * BNB Smart Chain is a CCTP domain (17), but for USYC only: Circle's docs say "USDC: Supported on all CCTP domains
 * except BNB Smart Chain" (developers.circle.com/cctp/concepts/supported-chains-and-domains, read 2026-10-03), and the
 * installed App Kit's BridgeChain enum has no entry for it. The USDC people hold there is Binance-Peg USDC, which
 * Circle doesn't burn and mint. A test fails once App Kit's BridgeChain gains it: then it moves to MAINNET/TESTNET.
 */
const UNSUPPORTED_MAINNET: UnsupportedChainOption[] = [{ label: "BNB Smart Chain", note: "not supported by Circle" }];
const UNSUPPORTED_TESTNET: UnsupportedChainOption[] = [
  { label: "BNB Smart Chain Testnet", note: "not supported by Circle" },
];

/** The chains the picker shows but can't offer, for the active network. Never part of `bridgeChainOptions()`. */
export function unsupportedBridgeChains(): UnsupportedChainOption[] {
  return activeNetwork() === "mainnet" ? UNSUPPORTED_MAINNET : UNSUPPORTED_TESTNET;
}

const ALL_OPTIONS: EvmChainOption[] = [...MAINNET, ...TESTNET];

/**
 * Friendly display name for any chain id this app can bridge with, including Arc itself —
 * `bridgeChainOptions()` deliberately excludes Arc from the "other chain" picker (it's always the
 * implicit other end), but a settled or in-flight bridge's `source`/`dest` can legitimately be Arc,
 * and error copy needs a name for it too. Falls back to the raw id for anything unrecognized.
 */
export function chainLabel(chainId: ChainId): string {
  if (chainId === "Arc") return "Arc";
  if (chainId === "Arc_Testnet") return "Arc Testnet";
  return ALL_OPTIONS.find((o) => o.chain === chainId)?.label ?? chainId;
}

/** What Bridge needs to know about one chain it can bridge with, taken from App Kit's own definition of it. */
export type BridgeChainInfo = {
  chainId: number;
  /** The RPC endpoints App Kit itself reads that chain through (and that the site's connect-src lists). */
  rpcEndpoints: readonly string[];
  usdcAddress: Address;
  /** The token that pays for gas there: ETH, POL, AVAX, or USDC on Arc. */
  gasSymbol: string;
};

const DEFINITIONS = [
  Arc,
  ArcTestnet,
  Ethereum,
  Base,
  Arbitrum,
  Optimism,
  Polygon,
  Avalanche,
  EthereumSepolia,
  BaseSepolia,
  ArbitrumSepolia,
  OptimismSepolia,
  PolygonAmoy,
  AvalancheFuji,
] as const;

/** One of App Kit's own chain definitions, as the kit's adapter wants it (`prepareAction`'s `fromChain`/`toChain`). */
export type KitChainDefinition = (typeof DEFINITIONS)[number];

/** App Kit's definition object for a chain Bridge offers (or Arc itself), or null for an id it doesn't know. */
export function kitChainDefinition(chainId: ChainId): KitChainDefinition | null {
  return DEFINITIONS.find((d) => d.chain === chainId) ?? null;
}

/**
 * The chain of the active network whose CCTP domain is `domain`, or null. Circle's attestation service names a
 * transfer's destination by its CCTP domain id (`decodedMessage.destinationDomain`), and a domain is shared by a
 * mainnet chain and its testnet (Base and Base Sepolia are both 6), so the active network decides which one it is.
 */
export function chainForDomain(domain: number): ChainId | null {
  const testnet = activeNetwork() !== "mainnet";
  return DEFINITIONS.find((d) => d.cctp.domain === domain && d.isTestnet === testnet)?.chain ?? null;
}

/** App Kit's definition of a chain Bridge offers (or Arc itself), or null for an id it doesn't know. */
export function bridgeChainInfo(chainId: ChainId): BridgeChainInfo | null {
  const def = kitChainDefinition(chainId);
  if (!def) return null;
  return {
    chainId: def.chainId,
    rpcEndpoints: def.rpcEndpoints,
    usdcAddress: def.usdcAddress as Address,
    gasSymbol: def.nativeCurrency.symbol,
  };
}
