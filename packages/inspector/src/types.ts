import type { Abi } from "viem";
import type { Address, DexConfig, NetworkId } from "@arcos/chain";
import type { Hex } from "./bytecode";
import type { ExplorerSource } from "./explorer";

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
export type CheckId = "verified" | "ownership" | "privileges" | "proxy" | "holders" | "liquidity" | "lp-lock" | "prevrandao";

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
  network: NetworkId;
  token: { name: string | null; symbol: string | null; decimals: number | null; totalSupply: string | null };
  findings: Finding[];
  /** Kept for compatibility: passed === counts.pass, total === findings.length. */
  passed: number;
  total: number;
  /** The same numbers, broken out by status — every surface should show `unknown` explicitly rather than folding it into "not pass". */
  counts: { pass: number; warn: number; fail: number; unknown: number };
  explorerReachable: boolean;
  /**
   * Some read this report relies on failed at the transport level, so a second try might read more:
   * - a `ChainReader` call failed: an HTTP error, a timeout, or a JSON-RPC error that isn't the node's answer (anything
   *   but a revert or -32602 invalid params; see rpc-errors.ts), on every endpoint the transport tried; or
   * - an explorer request ended in `ExplorerUnavailable`.
   * Never degraded: a revert or an empty answer (`CallReverted`), -32602, a 404 from the explorer, and viem failing to
   * decode what the node answered, since asking again returns the same. The findings mean what they always do; this
   * only says that some of the unknowns may be a network hiccup, so the report shouldn't be kept for long.
   */
  degraded: boolean;
  blockNumber: string;
  generatedAt: string;
};

/** The few chain reads the checks need. Small on purpose: trivial to fake in tests. */
export interface ChainReader {
  getCode(address: Address): Promise<Hex | null>;
  getStorageAt(address: Address, slot: Hex): Promise<Hex | null>;
  /**
   * Rejects with `CallReverted` when the call reverts or returns no data. Any other rejection is
   * a transport failure and means nothing about the contract. `options.gas` caps the call's gas: a read that could walk an
   * attacker-chosen amount of state (a v4 quote) gets a limit of its own.
   */
  read(address: Address, abi: Abi, functionName: string, args?: readonly unknown[], options?: { gas?: bigint }): Promise<unknown>;
  blockNumber(): Promise<bigint>;
}

/** A Uniswap v4 pool's identity. Its id is keccak256(abi.encode(key)). `currency0 < currency1`, and address(0) is native USDC. */
export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };

/**
 * A pool the caller already knows about, read live next to the ones discovery finds. The index supplies them (A6): that is
 * how a v4 pool with hooks, or a fee outside the standard five, gets seen. Nothing fills them yet.
 */
export type ExtraPool = { version: "v4"; key: PoolKey };

export type PoolVersion = "v2" | "v3" | "v4" | "aero";

export type Pool = {
  /** Where the pool's tokens sit: the pair or pool contract, or for v4 the PoolManager, which holds the tokens of every v4 pool. */
  address: Address;
  version: PoolVersion;
  /** The quote currency's symbol. Native USDC on v4 is "USDC" too. */
  quote: string;
  /**
   * In units of the quote currency, 6 decimals. v2, v3 and Aerodrome: the pool's balance of the quote token. v4: what the
   * active liquidity holds in range at the current price (see `quoteInRange` in v4.ts), not the pool's total.
   */
  depth: bigint;
  /**
   * The pool alone can pay out 1,000 units of the quote currency. v2, v3 and Aerodrome: `depth` is at least that. v4: a
   * V4Quoter exact-output quote for that amount succeeded, which is real, extractable USDC through the pool's own hooks.
   * `null` is undecided (see `undecided`); `false` is only ever the pool's own "not enough liquidity".
   */
  liquid: boolean | null;
  /** v4, with `liquid: null`. "quote-unavailable": the quote failed in some way that isn't the pool's own answer. */
  undecided?: "quote-unavailable";
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
};

export type InspectInput = {
  address: Address;
  network: NetworkId;
  reader: ChainReader;
  explorer: ExplorerSource | null;
  dex: DexConfig | null;
  knownLockers: Address[];
  /** e.g. https://explorer.arc.io — evidence links are built from it. */
  explorerBase: string;
  /** The 4rc.OS TokenFactory on this network. A token it created (`isArcosToken`) runs one of the factory's fixed
   * templates, whose source is published with the factory's verified source. */
  arcosTokenFactory?: Address | null;
  /** Pools to read besides the ones discovery finds, hooked v4 pools among them. From the index; nothing fills it yet. */
  extraPools?: ExtraPool[];
  now?: () => Date;
};
