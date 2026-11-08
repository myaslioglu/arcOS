import type { Chain } from "viem";
import { ARCOS, DEX, KNOWN_LOCKERS, USDC, type Address, type DexConfig } from "./addresses";
import { USDC_DECIMALS } from "./amounts";
import { CHAINS, type NetworkId } from "./chains";

/**
 * What Inspector needs to know about a chain, one entry per chain, so that nothing in @arcos/inspector assumes Arc: the
 * engine reads every chain-specific fact from the entry the caller passes (through `InspectInput`). Only Arc's entries
 * exist so far, built from CHAINS, DEX, ARCOS and KNOWN_LOCKERS, so they can't drift from what the rest of the site reads.
 */

/** The chains Inspector reads. */
export type InspectChainKey = "arc";

/**
 * A currency pools are quoted against. `usd` says how one unit converts to US dollars: "stable" is 1 unit = $1. A feed
 * (a Chainlink aggregator and the oldest answer that still counts, in seconds) is for a quote that isn't a stablecoin;
 * no entry has one yet.
 */
export type QuoteUsd = "stable" | { feed: Address; maxAgeS: number };
export type QuoteToken = { address: Address; symbol: string; decimals: number; usd: QuoteUsd };

/**
 * Uniswap v4's native currency (`address(0)`) as a quote currency. `erc20View` is the ERC-20 whose balances ARE the native
 * balances, when the chain has one (Arc's USDC at 0x3600, which shows them in 6 decimals): the same asset, so inspecting it
 * leaves the native currency out as a quote too, and a trade quote on it is funded through the native balance.
 */
export type NativeQuote = QuoteToken & { erc20View: Address | null };

/**
 * What the trade check buys the token with (an ERC-20 with `decimals` decimals), and how the simulation's state override
 * gives the throwaway account S some of it. `balanceSlot` is the storage slot of the token's `balanceOf` mapping, which the
 * override writes S's balance into. `null` means the token's balance IS the native balance, so the override sets S's
 * native balance instead: the token must then be the native quote's `erc20View` (Arc's USDC), or no trade is simulated.
 */
export type TradeQuote = { token: Address; decimals: number; balanceSlot: number | null };

/** One way a node answers an eth_call that ran out of its own gas: a JSON-RPC error code and what its message starts with. */
export type OutOfGasShape = { code: number; text: RegExp };

/** The prevrandao check's warning on this chain: what PREVRANDAO gives there, and the page that says so. */
export type PrevrandaoCopy = { warnTitle: string; detail: string; evidenceUrl: string };

export type InspectChain = {
  key: InspectChainKey;
  name: string;
  chainId: number;
  /** The chain's name in URLs. */
  slug: string;
  /** The chain's viem definition, with its public RPC URLs. */
  viem: Chain;
  /** The chain's Blockscout: `url` is the UI evidence links point at; `publicApiUrl` the API a browser may read. */
  explorer: { url: string; publicApiUrl: string | null };
  /** Another explorer worth linking next to the address ("Etherscan"); never evidence. */
  otherExplorer: { name: string; url: string } | null;
  /** The pools Inspector reads (see `DexConfig`); null when it reads none here. */
  dex: DexConfig | null;
  /** Uniswap v4's native currency, `address(0)`, as a quote currency; null when v4 pools against it aren't read. */
  nativeQuote: NativeQuote | null;
  /** null: no trade is simulated on this chain. */
  tradeQuote: TradeQuote | null;
  /** Lock contracts whose holdings of a v2 LP token count as locked. */
  knownLockers: Address[];
  /** `knownLockers` is a vetted list, so LP held anywhere else can be called unlocked. */
  lockersVetted: boolean;
  /** The kinds of pool on this chain that Inspector can't find, by name; empty when it reads every kind there is. */
  unscanned: string[];
  /** The ArcOS TokenFactory, whose tokens count as source-verified (`checkVerified` in @arcos/inspector). */
  arcosTokenFactory: Address | null;
  prevrandao: PrevrandaoCopy;
  /** How this chain's nodes say an eth_call ran out of its own gas: the node's answer, never the endpoint failing. */
  outOfGas: OutOfGasShape[];
};

/** Uniswap v4's name for the native currency. */
const NATIVE_CURRENCY: Address = "0x0000000000000000000000000000000000000000";

/**
 * Arc's nodes answer an eth_call that runs out of gas during execution with -32003 "out of gas: gas required exceeds: N"
 * (not -32000 "intrinsic gas too low", which is a refusal). The same on mainnet and testnet.
 */
const ARC_OUT_OF_GAS: OutOfGasShape[] = [{ code: -32003, text: /^out of gas/i }];

/** Arc sets PREVRANDAO to 0 in every block (Arc's "EVM differences" page). */
const ARC_PREVRANDAO: PrevrandaoCopy = {
  warnTitle: "Uses PREVRANDAO, which is always 0 on Arc",
  detail: "Any randomness derived from it is predictable.",
  evidenceUrl: "https://docs.arc.io/arc/references/evm-differences",
};

/**
 * Arc on `network`. Its native currency is USDC with 18 decimals (the chain definition's `nativeCurrency`), and the USDC
 * ERC-20 at 0x3600 shows the same balance in 6 decimals: v4 pools quote against both, and the trade check funds S through
 * the native balance. Every pool kind Arc has is read, hooked v4 pools through the index (`InspectInput.extraPools`), so
 * nothing is unscanned. `KNOWN_LOCKERS` is the vetted list, empty so far.
 */
function arc(network: NetworkId): InspectChain {
  const viem = CHAINS[network];
  const explorer = viem.blockExplorers?.default;
  return {
    key: "arc",
    name: viem.name,
    chainId: viem.id,
    slug: "arc",
    viem,
    explorer: { url: explorer?.url ?? "", publicApiUrl: explorer?.apiUrl ?? null },
    otherExplorer: null,
    dex: DEX[network],
    nativeQuote: { address: NATIVE_CURRENCY, symbol: viem.nativeCurrency.symbol, decimals: viem.nativeCurrency.decimals, usd: "stable", erc20View: USDC },
    tradeQuote: { token: USDC, decimals: USDC_DECIMALS, balanceSlot: null },
    knownLockers: KNOWN_LOCKERS[network],
    lockersVetted: true,
    unscanned: [],
    arcosTokenFactory: ARCOS[network]?.tokenFactory ?? null,
    prevrandao: ARC_PREVRANDAO,
    outOfGas: ARC_OUT_OF_GAS,
  };
}

/** The chains Inspector reads on each of the site's networks: Arc on both. */
export const INSPECT_CHAINS: Record<NetworkId, InspectChain[]> = {
  mainnet: [arc("mainnet")],
  testnet: [arc("testnet")],
};

/** The chain `key` names on `network`, or null when there is none. */
export function inspectChain(network: NetworkId, key: string): InspectChain | null {
  return INSPECT_CHAINS[network].find((c) => c.key === key) ?? null;
}

/** Arc's entry on `network`, which every network has. */
export function arcInspectChain(network: NetworkId): InspectChain {
  return inspectChain(network, "arc")!;
}

/** A page on the chain's explorer, as `explorerUrl` builds one for the site's own chain. */
export function chainExplorerUrl(chain: InspectChain, kind: "address" | "tx" | "token", value: string): string {
  return `${chain.explorer.url}/${kind}/${value}`;
}
