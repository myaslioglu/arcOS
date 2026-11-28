import type { Abi } from "viem";
import type { Address, DexConfig, InspectChainKey, NativeQuote, NetworkId, PrevrandaoCopy, TradeQuote } from "@arcos/chain";
import type { Hex } from "./bytecode";
import type { ExplorerSource } from "./explorer";
import type { VerificationSource } from "./sourcify";

/**
 * The call reached the chain and reverted (or returned no data): the function isn't there, or it said no. `data` is what it
 * reverted with, when the node sent any: an error selector and its arguments, `null` for a bare revert or an empty answer.
 */
export class CallReverted extends Error {
  constructor(message = "execution reverted", readonly data: Hex | null = null) {
    super(message);
    this.name = "CallReverted";
  }
}

export type Status = "pass" | "warn" | "fail" | "unknown";
export type CheckId = "verified" | "ownership" | "privileges" | "proxy" | "holders" | "liquidity" | "lp-lock" | "prevrandao" | "trade";

export type Finding = {
  id: CheckId;
  status: Status;
  title: string;
  detail: string;
  evidenceUrl: string | null;
  fixAppId: "vault" | "vesting" | null;
};

export type Report = {
  address: Address;
  /** The site's network (its build), which every report of it carries, whichever chain it read. */
  network: NetworkId;
  /** The chain the report read (`InspectInput.chain`), and its chain id. */
  chain: InspectChainKey;
  chainId: number;
  token: { name: string | null; symbol: string | null; decimals: number | null; totalSupply: string | null };
  findings: Finding[];
  /** Kept for compatibility: passed === counts.pass, total === findings.length. */
  passed: number;
  total: number;
  /** The same numbers, broken out by status — every surface should show `unknown` explicitly rather than folding it into "not pass". */
  counts: { pass: number; warn: number; fail: number; unknown: number };
  explorerReachable: boolean;
  /**
   * Why the explorer wasn't asked at all, when that was on purpose (`InspectInput.explorerSkipped`): the sentence the
   * explorer-based findings give in place of "The explorer didn't answer". Absent when the explorer was asked, or had to
   * be done without for any other reason.
   */
  explorerSkipped?: string;
  /**
   * Some read this report relies on failed at the transport level, so a second try might read more:
   * - a `ChainReader` call failed: an HTTP error, a timeout, or a JSON-RPC error that isn't the node's answer (anything
   *   but a revert or -32602 invalid params; see rpc-errors.ts), on every endpoint the transport tried; or
   * - an explorer request ended in `ExplorerUnavailable`.
   * Never degraded: a revert or an empty answer (`CallReverted`), a call that set its own gas limit running out of it (a v4
   * quote, the trade simulation), -32602, a 404 from the explorer, and viem failing to decode what the node answered, since
   * asking again returns the same. The findings mean what they always do; this
   * only says that some of the unknowns may be a network hiccup, so the report shouldn't be kept for long.
   */
  degraded: boolean;
  blockNumber: string;
  generatedAt: string;
};

/** What a `ChainReader.read` may carry besides the call: a gas cap and the block to read at. Both optional. */
export type ReadOptions = { gas?: bigint; blockNumber?: bigint };

/** The few chain reads the checks need. Small on purpose: trivial to fake in tests. */
export interface ChainReader {
  getCode(address: Address): Promise<Hex | null>;
  /** The slot's word at `blockNumber`, or at the latest block when none is given. */
  getStorageAt(address: Address, slot: Hex, blockNumber?: bigint): Promise<Hex | null>;
  /**
   * Rejects with `CallReverted` when the call reverts or returns no data. Any other rejection is
   * a transport failure and means nothing about the contract. `options.gas` caps the call's gas: a read that could walk an
   * attacker-chosen amount of state (a v4 quote) gets a limit of its own. `options.blockNumber` pins the call to a block
   * (Watchdog reads every token at one finalized block); without it the call is at the latest block.
   */
  read(address: Address, abi: Abi, functionName: string, args?: readonly unknown[], options?: ReadOptions): Promise<unknown>;
  blockNumber(): Promise<bigint>;
  /** The network's current gas price (eth_gasPrice), in wei. */
  gasPrice(): Promise<bigint>;
  /**
   * One eth_call with some accounts' state replaced for that call only (the RPC's third parameter): the trade simulation's
   * code and USDC balance at a throwaway address. Resolves with what the call returned, `0x` included (code that never ran,
   * when a node ignores the override, answers that). The gas limit is always set, so it rejects with `CallReverted` when
   * the call reverts or runs out of that gas (the chain's out-of-gas answer, `InspectChain.outOfGas`), both the node's
   * answer; anything else, a node refusing the override included, is passed on as it came.
   */
  callWithOverride(call: OverrideCall, overrides: readonly StateOverride[]): Promise<Hex>;
  /**
   * One eth_getLogs over [fromBlock, toBlock], inclusive, for one contract. `topics` is the RPC's own filter: a position is
   * one topic, a list of them (any matches), or null (anything). The lp-lock check reads the tail of the position index
   * with it, over at most 10,000 blocks. Rejects when the node refuses the range or doesn't answer.
   */
  logs(filter: LogFilter): Promise<ChainLog[]>;
}

export type LogFilter = { address: Address; topics: readonly (Hex | readonly Hex[] | null)[]; fromBlock: bigint; toBlock: bigint };
/** One log, as far as the checks read it. */
export type ChainLog = { topics: readonly Hex[]; data: Hex; blockNumber: bigint };

/** The call `ChainReader.callWithOverride` makes, at `gasPrice` (wei per gas), which `from` must hold enough to prepay. */
export type OverrideCall = { from: Address; to: Address; data: Hex; gas: bigint; gasPrice: bigint };
/**
 * One account's state for one call: its code, its native balance (in wei), and storage words to write over its own
 * (`stateDiff`: each slot set to its 32-byte value, the rest of its storage kept), each optional.
 */
export type StateOverride = { address: Address; code?: Hex; balance?: bigint; stateDiff?: { slot: Hex; value: Hex }[] };

/**
 * A Uniswap v4 pool's identity. Its id is keccak256(abi.encode(key)). `currency0 < currency1`, and address(0) is the chain's
 * native currency (`InspectInput.nativeQuote`; on Arc, USDC).
 */
export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };

/**
 * A pool the caller already knows about, read live next to the ones discovery finds. The index supplies them (pools/ in Firestore): that is
 * how a v4 pool with hooks, or a fee outside the standard five, gets seen.
 */
export type ExtraPool = { version: "v4"; key: PoolKey };

/**
 * One liquidity position in a Uniswap v4 pool, as the PoolManager keys it: the address that called `modifyLiquidity`
 * (`owner`: the PositionManager for an NFT position, whose `salt` is then `bytes32(tokenId)`), the tick range and the salt.
 */
export type V4PositionKey = { owner: Address; tickLower: number; tickUpper: number; salt: Hex };

/** The positions the index holds for one pool. `truncated`: there are more than the list carries. */
export type V4PoolPositions = { positions: V4PositionKey[]; truncated: boolean };

/**
 * The position index for a token's Uniswap v4 pools (`positions/` in Firestore, filled by the indexer from the PoolManager's
 * `ModifyLiquidity` logs). `cursor` is the last block whose logs the index has handled: a position opened after it isn't in
 * the lists, and the lp-lock check reads those blocks itself. `pools` is keyed by pool id, lowercase; a pool with no
 * entry was not looked up, which is not the same as having no positions (an empty list). Plain JSON, so it crosses the
 * network as it is.
 */
export type V4PositionIndex = { cursor: number; pools: Record<string, V4PoolPositions> };

/** `aero` is Slipstream (Aerodrome's, or Velodrome's), `solidly` the classic pools of the same two. */
export type PoolVersion = "v2" | "v3" | "v4" | "aero" | "solidly";

export type Pool = {
  /** Where the pool's tokens sit: the pair or pool contract, or for v4 the PoolManager, which holds the tokens of every v4 pool. */
  address: Address;
  version: PoolVersion;
  /** The quote currency's symbol: a quote token's, or on v4 the native currency's (`InspectInput.nativeQuote`, "USDC" on Arc). */
  quote: string;
  /**
   * In units of the quote currency, 6 decimals. v2, v3, Slipstream and the classic pools: the pool's balance of the quote
   * token. v4: what the active liquidity holds in range at the current price (see `quoteInRange` in v4.ts), not the
   * pool's total. For a stable quote that is US dollars; for one that isn't priced (`undecided: "unpriced"`, WETH) it is
   * the quote's own units, kept for display, and never set against a dollar figure.
   */
  depth: bigint;
  /**
   * The pool alone can pay out 1,000 units of the quote currency. v2, v3 and Aerodrome: `depth` is at least that. v4: a
   * pool without a hook, and a V4Quoter exact-output quote for that amount succeeded. `null` is undecided (see `undecided`);
   * `false` is only ever a hookless pool's own "not enough liquidity".
   */
  liquid: boolean | null;
  /** With `liquid: null`. v4: "quote-unavailable", the quote failed in some way that isn't the pool's own answer; "hook",
   * the pool has a hook, which runs inside any swap and so could fake a quote either way, and it isn't quoted. Any kind:
   * "unpriced", its quote currency has no US dollar rate yet (WETH, native ETH), so 1,000 units can't be judged. */
  undecided?: "quote-unavailable" | "hook" | "unpriced";
  /**
   * v2: whether its reserves hold any tokens at all. `false` for a pair holding USDC `sync`ed in and nothing to sell for
   * it, whatever its depth; such a pair is never liquid and the trade check never trades against it. A pair with tokens
   * is `true` even when it quotes nothing for the test amount or is thin; it is liquid only with 1,000 USDC and a nonzero
   * quote. The classic pools (`solidly`) are always `false`: the trade simulation doesn't swap through them yet.
   */
  tradable?: boolean;
  /** v2 only: the token's reserve, in its raw units, next to `depth`, the USDC (or EURC) reserve. */
  tokenReserve?: bigint;
  /** v3 only: the fee tier the factory was asked for, in hundredths of a bip (3000 is 0.3%). */
  fee?: number;
  /** v4 only. */
  poolId?: Hex;
  key?: PoolKey;
};

/**
 * What the pool lookup found, and whether the pool contracts answered at all. An address with no contract code reverts
 * every call it's given (and inside a multicall answers `0x`), which reaches this code as "no pool", identical to a working
 * contract saying there is none. "No pool found" read off a contract that never answered is a claim about pools that
 * nothing actually checked.
 */
export type PoolScan = {
  pools: Pool[];
  /** Some pool contract answered: a factory call, or v4's StateView, came back with an answer. */
  factoriesAnswered: boolean;
  /**
   * The configured families, by name, none of whose contracts answered. What they said about pools isn't evidence, so
   * "no pool" and "thin" can't be claimed while one is silent; a liquid pool found elsewhere still stands.
   */
  silent: string[];
  /**
   * The index listed more v4 pools for the token than discovery reads (`MAX_EXTRA_POOLS`), so some were not looked at.
   * Absent or false: every pool the index listed was read.
   */
  truncated?: boolean;
};

/**
 * One inspection. The fields that describe the chain (`chain`, `dex`, `knownLockers`, `explorerBase`, `arcosTokenFactory`,
 * `nativeQuote`, `tradeQuote`, `lockersVetted`, `unscanned`, `prevrandao`, `unverifiedFails`) come from its registry entry
 * (`InspectChain` in @arcos/chain), through `chainInput`: nothing in the engine assumes which chain it reads.
 */
export type InspectInput = {
  address: Address;
  /** The site's network (its build), carried into the report. */
  network: NetworkId;
  /** The chain read, as the report names it. */
  chain: { key: InspectChainKey; name: string; chainId: number };
  reader: ChainReader;
  explorer: ExplorerSource | null;
  dex: DexConfig | null;
  knownLockers: Address[];
  /** e.g. https://explorer.arc.io — evidence links are built from it. */
  explorerBase: string;
  /** The ArcOS TokenFactory on this network. A token it created (`isArcosToken`) runs one of the factory's fixed
   * templates, whose source is published with the factory's verified source. */
  arcosTokenFactory?: Address | null;
  /**
   * Uniswap v4's native currency (`address(0)`) as a quote currency, with its symbol and decimals and the ERC-20 that shows
   * the same balances (`erc20View`): on Arc, USDC with 18 decimals, viewed by the USDC ERC-20 at 0x3600. null: v4 pools
   * against the native currency aren't looked for.
   */
  nativeQuote: NativeQuote | null;
  /**
   * What the trade check buys with, and how the simulation funds the throwaway account with it: on Arc, the USDC ERC-20 at
   * 0x3600 (6 decimals), the native quote's `erc20View`, funded through the native balance (`balanceSlot: null`). null: no
   * trade is simulated.
   */
  tradeQuote: TradeQuote | null;
  /**
   * `knownLockers` is a vetted list of the chain's lock contracts, so LP held anywhere else can be called unlocked (Arc's
   * is). Where it isn't, lp-lock never fails: LP that isn't burned is unknown.
   */
  lockersVetted: boolean;
  /**
   * The kinds of pool on the chain that discovery can't see, by name. Arc has none. With any, the liquidity check never
   * says "no pool" or "thin": a pool where it can't look may be there.
   */
  unscanned: string[];
  /** The prevrandao check's warning on this chain. */
  prevrandao: PrevrandaoCopy;
  /**
   * An explorer's explicit "not verified" (Blockscout's `is_verified: false`, and no match in `verifyFallback` when one is
   * asked) is a fail. Where it isn't (every chain but Arc: Etherscan, which isn't read, holds sources Blockscout may not),
   * it is unknown, whether `verifyFallback` is given or not.
   */
  unverifiedFails: boolean;
  /**
   * A second place to ask whether the code that runs is verified (Sourcify, off Arc): a match there is a pass, and its
   * "no match" is half of what a fail needs. Absent or null: only the explorer is asked.
   */
  verifyFallback?: VerificationSource | null;
  /**
   * Why `explorer` is null on purpose, as the sentence the explorer-based findings give instead of "The explorer didn't
   * answer" (the server's daily allowance of explorer calls is spent, say). The report carries it too (`Report.explorerSkipped`).
   */
  explorerSkipped?: string;
  /** Pools to read besides the ones discovery finds, hooked v4 pools among them. From the index (`pools/` in Firestore, filled by the indexer). */
  extraPools?: ExtraPool[];
  /**
   * The index holds more pools for this token than `extraPools` lists (its read stops at a limit). The lp-lock check
   * can't then add up the token's liquidity: a pool nobody listed is a pool nobody read.
   */
  extraPoolsTruncated?: boolean;
  /**
   * The index's positions for this token's Uniswap v4 pools (see `V4PositionIndex`): the pools the index lists for the
   * token. With it, lp-lock reads who holds the liquidity of v4 pools. Without it, a v4 pool's positions can't be read
   * and lp-lock answers as it did before there was an index.
   */
  v4Positions?: V4PositionIndex;
  /**
   * Called once with what the pool lookup found, or null when it failed, before the findings are made from it. The indexer
   * stores the best pool from it (`bestPool`), so it needs no second lookup. A hook that throws changes nothing.
   */
  onPools?: (scan: PoolScan | null) => void;
  now?: () => Date;
  /**
   * When the caller stops waiting for the report (ms since the epoch, on `Date.now()`'s clock): the inspection's own
   * deadline. The trade check fits its eth_calls inside it (see simulate.ts). Absent: it gives itself a fixed time.
   */
  deadlineAt?: number;
};
