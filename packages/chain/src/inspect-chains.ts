import { defineChain, type Chain } from "viem";
import { arbitrum as viemArbitrum, base as viemBase, mainnet as viemMainnet, optimism as viemOptimism } from "viem/chains";
import { ARCOS, DEX, KNOWN_LOCKERS, USDC, type Address, type DexConfig, type QuoteUsd } from "./addresses";
import { USDC_DECIMALS } from "./amounts";
import { CHAINS, type NetworkId } from "./chains";

/**
 * What Inspector needs to know about a chain, one entry per chain, so that nothing in @arcos/inspector assumes Arc: the
 * engine reads every chain-specific fact from the entry the caller passes (through `InspectInput`). Arc's entries are built
 * from CHAINS, DEX, ARCOS and KNOWN_LOCKERS, so they can't drift from what the rest of the site reads. Ethereum, Base,
 * Arbitrum One and OP Mainnet exist on the mainnet site only, each read by the server alone, and each switched on by
 * `NEXT_PUBLIC_INSPECT_CHAINS` (see `enabledInspectChains`).
 */

/** The chains Inspector reads. */
export type InspectChainKey = "arc" | "ethereum" | "base" | "arbitrum" | "optimism";

/** A currency pools are quoted against, with how it converts to US dollars (see `QuoteUsd` in addresses.ts). */
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
  /** The chain's viem definition, with its public RPC URLs: the server puts its keyed provider in front of them. */
  viem: Chain;
  /** The chain's Blockscout: `url` is the UI evidence links point at; `publicApiUrl` the API a browser may read (Arc only). */
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
  /**
   * The kinds of pool on this chain that Inspector can't find, by name, each a plural noun phrase ("pools on other
   * DEXes"); empty when it reads every kind there is. With any, "no pool" and "thin" are claims nobody can make here.
   */
  unscanned: string[];
  /** The ArcOS TokenFactory, whose tokens count as source-verified (`checkVerified` in @arcos/inspector). */
  arcosTokenFactory: Address | null;
  /**
   * An explorer's explicit "not verified" can be a fail here. True on Arc, whose explorer is where sources are verified.
   * Elsewhere most sources are verified on Etherscan, which Inspector doesn't read, so it stays unknown until the two are
   * measured to agree (docs/INSPECTOR-CHAINS.md).
   */
  unverifiedFails: boolean;
  /** Sourcify is asked whether the code that runs is verified (a match there is a pass). Off on Arc. */
  sourcify: boolean;
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
    unverifiedFails: true,
    sourcify: false,
    prevrandao: ARC_PREVRANDAO,
    outOfGas: ARC_OUT_OF_GAS,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Ethereum, Base, Arbitrum One and OP Mainnet. Every address below returned code from eth_getCode and was cross-read on
// 2026-11-27, through Alchemy and again through the chain's public RPC (packages/inspector/live/chains.live.test.ts reads
// them all again; docs/INSPECTOR-CHAINS.md has the figures):
// - USDC, USDT and WETH: `symbol()` and `decimals()` as written here (Arbitrum's USDT calls itself "USD₮0").
// - Uniswap v2 and v3: the factory's `getPair(USDC, WETH)`, and `getPool(USDC, WETH, fee)` at every fee tier listed, name
//   a pool whose own `factory()` is that factory.
// - Uniswap v4: the PositionManager, StateView and V4Quoter each answer `poolManager()` with the PoolManager.
// - Slipstream (Aerodrome on Base, Velodrome on OP Mainnet): the position manager's `factory()` is the factory, and
//   `tickSpacings()` answered [1, 50, 100, 200, 2000, 10] (sorted here). A second factory of the same code serves other
//   Slipstream pools on each chain (Base 0xaDe65c38CD4849aDBA595a4323a8C7DdfE89716a, 2,318 pools; OP Mainnet
//   0x548118C7E0B865C2CfA94D15EC86B666468ac758, 51 pools); whose it is wasn't confirmed, so its pools are unscanned.
// - Solidly (the classic pools of the same two): `getPool(USDC, WETH, false)` and `getPool(USDC, WETH, true)` name pools
//   whose `factory()` is the factory and which `isPool` accepts.
// - USDC keeps balances in the mapping at storage slot 9 on all four: under an eth_call state override that writes
//   keccak256(abi.encode(S, 9)), `balanceOf(S)` answers the amount written, on Alchemy and on the public RPC alike.
// ---------------------------------------------------------------------------------------------------------------------

/** Native ETH as a v4 quote. It isn't priced yet, so v4 pools against it are found but never called liquid or thin. */
const ETH_NATIVE: NativeQuote = { address: NATIVE_CURRENCY, symbol: "ETH", decimals: 18, usd: "unpriced", erc20View: null };

/** Uniswap v3's four fee tiers, the same on every chain here. */
const V3_FEE_TIERS = [100, 500, 3000, 10000];

/** Slipstream's tick spacings on Base and OP Mainnet, as both factories' `tickSpacings()` answered them, sorted. */
const SLIPSTREAM_TICK_SPACINGS = [1, 10, 50, 100, 200, 2000];

/** Where a chain's discovery stops, besides what a chain adds of its own. No index lists hooked v4 pools off Arc. */
const UNSCANNED_V4 = "Uniswap v4 pools with a hook or an unusual fee";
const UNSCANNED_OTHER_DEXES = "pools on other DEXes";
const UNSCANNED_OTHER_SLIPSTREAM = "Slipstream pools from other factories";

/**
 * Out of gas, measured on 2026-11-27 with an eth_call of an endless loop placed by a state override and capped at 100,000
 * gas. geth (Ethereum) and op-geth (Base, OP Mainnet) answer -32003 "out of gas: gas required exceeds: 100000", through
 * Alchemy and the public RPC alike. Arbitrum's Nitro answers -32000: "out of gas: gas required exceeds: 100000" through
 * Alchemy, "out of gas" through arb1.arbitrum.io. A gas limit under the intrinsic cost is -32000 "intrinsic gas too low"
 * everywhere, a refusal, and matches neither.
 */
const GETH_OUT_OF_GAS: OutOfGasShape[] = [{ code: -32003, text: /^out of gas/i }];
const NITRO_OUT_OF_GAS: OutOfGasShape[] = [{ code: -32000, text: /^out of gas/i }];

/** EIP-4399, "Security considerations": a block's proposer knows the value ahead and has a bit of influence on it. */
const ETHEREUM_PREVRANDAO: PrevrandaoCopy = {
  warnTitle: "Uses PREVRANDAO, which validators can bias",
  detail: "Each block's proposer knows it in advance and can bias it by skipping a slot, so randomness derived from it can be gamed.",
  evidenceUrl: "https://eips.ethereum.org/EIPS/eip-4399#security-considerations",
};

/** Arbitrum's "Solidity support" page: `block.prevrandao` "Returns the constant 1". */
const ARBITRUM_PREVRANDAO: PrevrandaoCopy = {
  warnTitle: "Uses PREVRANDAO, always 1 on Arbitrum",
  detail: "Any randomness derived from it is predictable.",
  evidenceUrl: "https://docs.arbitrum.io/build-decentralized-apps/arbitrum-vs-ethereum/solidity-support",
};

/**
 * The OP Stack's "Differences" page: PREVRANDAO returns L1's most recent RANDAO value at the current L1 origin block. The
 * sequencer picks that block, and the value is known before the L2 block is made.
 */
const opStackPrevrandao = (chain: string): PrevrandaoCopy => ({
  warnTitle: `Uses PREVRANDAO, predictable on ${chain}`,
  detail: "It is Ethereum's RANDAO value at the L1 block the sequencer builds on, known before the block is made, so randomness derived from it is predictable.",
  evidenceUrl: "https://docs.optimism.io/stack/differences",
});

/** `chain` with only `rpc` as its RPC: the public fallback the server keeps behind its keyed provider. */
const withRpc = (chain: Chain, rpc: string): Chain => defineChain({ ...chain, rpcUrls: { default: { http: [rpc] } } });

/** What the four chains share: no TokenFactory, no vetted lockers, Sourcify asked, no fail on an explorer's "not verified". */
const OFF_ARC = { knownLockers: [] as Address[], lockersVetted: false, arcosTokenFactory: null, unverifiedFails: false, sourcify: true } as const;

const ETHEREUM: InspectChain = {
  key: "ethereum",
  name: viemMainnet.name,
  chainId: viemMainnet.id,
  slug: "ethereum",
  viem: withRpc(viemMainnet, "https://ethereum-rpc.publicnode.com"),
  explorer: { url: "https://eth.blockscout.com", publicApiUrl: null },
  otherExplorer: { name: "Etherscan", url: "https://etherscan.io" },
  dex: {
    quoteTokens: [
      { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6, usd: "stable" },
      { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT", decimals: 6, usd: "stable" },
      { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", symbol: "WETH", decimals: 18, usd: "unpriced" },
    ],
    v2Factory: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
    v3Factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    v3FeeTiers: V3_FEE_TIERS,
    v4: {
      poolManager: "0x000000000004444c5dc75cB358380D2e3dE08A90",
      positionManager: "0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e",
      stateView: "0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227",
      quoter: "0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203",
    },
  },
  nativeQuote: ETH_NATIVE,
  tradeQuote: { token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, balanceSlot: 9 },
  ...OFF_ARC,
  unscanned: [UNSCANNED_V4, UNSCANNED_OTHER_DEXES],
  prevrandao: ETHEREUM_PREVRANDAO,
  outOfGas: GETH_OUT_OF_GAS,
};

const BASE: InspectChain = {
  key: "base",
  name: viemBase.name,
  chainId: viemBase.id,
  slug: "base",
  viem: withRpc(viemBase, "https://mainnet.base.org"),
  explorer: { url: "https://base.blockscout.com", publicApiUrl: null },
  otherExplorer: { name: "Basescan", url: "https://basescan.org" },
  dex: {
    quoteTokens: [
      { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6, usd: "stable" },
      { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: 18, usd: "unpriced" },
    ],
    v2Factory: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
    v3Factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    v3FeeTiers: V3_FEE_TIERS,
    v4: {
      poolManager: "0x498581fF718922c3f8e6A244956aF099B2652b2b",
      positionManager: "0x7C5f5A4bBd8fD63184577525326123B519429bDc",
      stateView: "0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71",
      quoter: "0x0d5e0F971ED27FBfF6c2837bf31316121532048D",
    },
    aero: {
      clFactory: "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A",
      positionManager: "0x827922686190790b37229fd06084350E74485b72",
      tickSpacings: SLIPSTREAM_TICK_SPACINGS,
      name: "Aerodrome Slipstream",
    },
    solidly: { factory: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da", name: "Aerodrome classic" },
  },
  nativeQuote: ETH_NATIVE,
  tradeQuote: { token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, balanceSlot: 9 },
  ...OFF_ARC,
  unscanned: [UNSCANNED_V4, UNSCANNED_OTHER_SLIPSTREAM, UNSCANNED_OTHER_DEXES],
  prevrandao: opStackPrevrandao("Base"),
  outOfGas: GETH_OUT_OF_GAS,
};

const ARBITRUM: InspectChain = {
  key: "arbitrum",
  name: viemArbitrum.name,
  chainId: viemArbitrum.id,
  slug: "arbitrum",
  viem: withRpc(viemArbitrum, "https://arb1.arbitrum.io/rpc"),
  explorer: { url: "https://arbitrum.blockscout.com", publicApiUrl: null },
  otherExplorer: { name: "Arbiscan", url: "https://arbiscan.io" },
  dex: {
    quoteTokens: [
      { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", symbol: "USDC", decimals: 6, usd: "stable" },
      { address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", symbol: "USDT", decimals: 6, usd: "stable" },
      { address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", symbol: "WETH", decimals: 18, usd: "unpriced" },
    ],
    v2Factory: "0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9",
    v3Factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    v3FeeTiers: V3_FEE_TIERS,
    v4: {
      poolManager: "0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32",
      positionManager: "0xd88F38F930b7952f2DB2432Cb002E7abbF3dD869",
      stateView: "0x76Fd297e2D437cd7f76d50F01AfE6160f86e9990",
      quoter: "0x3972C00f7ed4885e145823eb7C655375d275A1C5",
    },
  },
  nativeQuote: ETH_NATIVE,
  tradeQuote: { token: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6, balanceSlot: 9 },
  ...OFF_ARC,
  unscanned: [UNSCANNED_V4, UNSCANNED_OTHER_DEXES],
  prevrandao: ARBITRUM_PREVRANDAO,
  outOfGas: NITRO_OUT_OF_GAS,
};

const OPTIMISM: InspectChain = {
  key: "optimism",
  name: viemOptimism.name,
  chainId: viemOptimism.id,
  slug: "optimism",
  viem: withRpc(viemOptimism, "https://mainnet.optimism.io"),
  explorer: { url: "https://optimism.blockscout.com", publicApiUrl: null },
  otherExplorer: { name: "Optimistic Etherscan", url: "https://optimistic.etherscan.io" },
  dex: {
    quoteTokens: [
      { address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", symbol: "USDC", decimals: 6, usd: "stable" },
      { address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", symbol: "USDT", decimals: 6, usd: "stable" },
      { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: 18, usd: "unpriced" },
    ],
    v2Factory: "0x0c3c1c532F1e39EdF36BE9Fe0bE1410313E074Bf",
    v3Factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    v3FeeTiers: V3_FEE_TIERS,
    v4: {
      poolManager: "0x9a13F98Cb987694C9F086b1F5eB990EeA8264Ec3",
      positionManager: "0x3C3Ea4B57a46241e54610e5f022E5c45859A1017",
      stateView: "0xc18a3169788F4F75A170290584ECA6395C75Ecdb",
      quoter: "0x1f3131A13296FB91C90870043742C3CDBFF1A8d7",
    },
    aero: {
      clFactory: "0xCc0bDDB707055e04e497aB22a59c2aF4391cd12F",
      positionManager: "0x416b433906b1B72FA758e166e239c43d68dC6F29",
      tickSpacings: SLIPSTREAM_TICK_SPACINGS,
      name: "Velodrome Slipstream",
    },
    solidly: { factory: "0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a", name: "Velodrome classic" },
  },
  nativeQuote: ETH_NATIVE,
  tradeQuote: { token: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", decimals: 6, balanceSlot: 9 },
  ...OFF_ARC,
  unscanned: [UNSCANNED_V4, UNSCANNED_OTHER_SLIPSTREAM, UNSCANNED_OTHER_DEXES],
  prevrandao: opStackPrevrandao("OP Mainnet"),
  outOfGas: GETH_OUT_OF_GAS,
};

/** Every chain the registry knows on each of the site's networks: Arc first. The others exist on mainnet only. */
export const INSPECT_CHAINS: Record<NetworkId, InspectChain[]> = {
  mainnet: [arc("mainnet"), ETHEREUM, BASE, ARBITRUM, OPTIMISM],
  testnet: [arc("testnet")],
};

/** The chain `key` names on `network`, or null when there is none. Whether it is switched on is `enabledInspectChain`'s. */
export function inspectChain(network: NetworkId, key: string): InspectChain | null {
  return INSPECT_CHAINS[network].find((c) => c.key === key) ?? null;
}

/** Arc's entry on `network`, which every network has. */
export function arcInspectChain(network: NetworkId): InspectChain {
  return inspectChain(network, "arc")!;
}

/**
 * The chains besides Arc that `flag` switches on: `NEXT_PUBLIC_INSPECT_CHAINS`, slugs separated by commas
 * ("ethereum,base,arbitrum,optimism"), each on its own. Unset or empty: none. Anything that isn't a slug is ignored, and
 * so is "arc", which is always on.
 */
export function enabledChainSlugs(flag: string | undefined = process.env.NEXT_PUBLIC_INSPECT_CHAINS): Set<string> {
  return new Set(
    (flag ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "" && s !== "arc"),
  );
}

/** The chains Inspector reads on `network` with `flag`: Arc first, then each one the flag switches on, in registry order. */
export function enabledInspectChains(network: NetworkId, flag?: string): InspectChain[] {
  const on = enabledChainSlugs(flag);
  return INSPECT_CHAINS[network].filter((c) => c.key === "arc" || on.has(c.slug));
}

/** The chain whose slug is `slug` on `network`, when it is switched on (Arc always is); null otherwise. */
export function enabledInspectChain(network: NetworkId, slug: string, flag?: string): InspectChain | null {
  return enabledInspectChains(network, flag).find((c) => c.slug === slug) ?? null;
}

/** A page on the chain's explorer, as `explorerUrl` builds one for the site's own chain. */
export function chainExplorerUrl(chain: InspectChain, kind: "address" | "tx" | "token", value: string): string {
  return `${chain.explorer.url}/${kind}/${value}`;
}

/** The same page on the chain's other explorer ("Open on Etherscan"), or null where there is none (Arc). Never evidence. */
export function otherExplorerUrl(chain: InspectChain, kind: "address" | "tx" | "token", value: string): string | null {
  return chain.otherExplorer ? `${chain.otherExplorer.url}/${kind}/${value}` : null;
}
