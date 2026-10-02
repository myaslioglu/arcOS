import { encodeAbiParameters, encodeEventTopics, parseAbi, type Hex } from "viem";
import { ARCOS, DEX, USDC, tokenFactoryAbi, type Address } from "@arcos/chain";
import type { PoolScan, Report } from "@arcos/inspector";
import type { RawLog } from "../indexer/events";
import { RangeRefused, type LogChain } from "../indexer/rpc";
import type { ExplorerBudget, InspectToken } from "../indexer/run";

const v3Abi = parseAbi(["event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)"]);
const initAbi = parseAbi([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
]);

const hex = (n: number): Hex => `0x${n.toString(16)}`;
/** Arc's block time, about 0.507 s (F8), from a made-up genesis. */
export const timeOf = (block: number) => 1_780_000_000 + Math.floor(block / 2);

export const addr = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}`;
export const ZERO: Address = "0x0000000000000000000000000000000000000000";
export const USDC_LOWER = USDC.toLowerCase() as Address;

/** A Uniswap v3 PoolCreated of `token` against USDC at `block`. */
export function v3Pool(block: number, token: Address, pool: Address, logIndex = 0): RawLog {
  const [token0, token1] = token.toLowerCase() < USDC_LOWER ? [token, USDC] : [USDC, token];
  return {
    address: DEX.mainnet!.v3Factory!,
    topics: encodeEventTopics({ abi: v3Abi, eventName: "PoolCreated", args: { token0, token1, fee: 3000 } }) as Hex[],
    data: encodeAbiParameters([{ type: "int24" }, { type: "address" }], [60, pool]),
    blockNumber: hex(block),
    logIndex: hex(logIndex),
    blockTimestamp: hex(timeOf(block)),
  };
}

/** A Uniswap v4 Initialize of `token` against native USDC, with `hooks`. */
export function v4Pool(block: number, token: Address, id: Hex, hooks: Address = ZERO, logIndex = 0): RawLog {
  return {
    address: DEX.mainnet!.v4!.poolManager,
    topics: encodeEventTopics({ abi: initAbi, eventName: "Initialize", args: { id, currency0: ZERO, currency1: token } }) as Hex[],
    data: encodeAbiParameters(
      [{ type: "uint24" }, { type: "int24" }, { type: "address" }, { type: "uint160" }, { type: "int24" }],
      [10_000, 200, hooks, 2n ** 96n, 0],
    ),
    blockNumber: hex(block),
    logIndex: hex(logIndex),
    blockTimestamp: hex(timeOf(block)),
  };
}

/** A 4rc.OS TokenFactory TokenCreated. */
export function created(block: number, token: Address, symbol: string, logIndex = 0): RawLog {
  return {
    address: ARCOS.mainnet!.tokenFactory,
    topics: encodeEventTopics({ abi: tokenFactoryAbi, eventName: "TokenCreated", args: { creator: addr(0xc0ffee), token, holder: addr(0xc0ffee) } }) as Hex[],
    data: encodeAbiParameters(
      [{ type: "string" }, { type: "string" }, { type: "uint8" }, { type: "uint256" }, { type: "uint256" }, { type: "bool" }, { type: "bool" }],
      [`${symbol} token`, symbol, 18, 10n ** 24n, 0n, false, false],
    ),
    blockNumber: hex(block),
    logIndex: hex(logIndex),
    blockTimestamp: hex(timeOf(block)),
  };
}

export type FakeChainOptions = {
  head: number;
  logs?: RawLog[];
  /** The node refuses any window wider than this (as -32012 would). */
  maxSpan?: number;
  /** The node refuses even this one block. */
  refuseBlock?: number;
  /** The nth eth_getLogs call (1-based) fails at the transport level. */
  failCall?: number;
};

/** A chain the tests control. Every eth_getLogs it answers is recorded. */
export function fakeChain(options: FakeChainOptions): LogChain & { asked: { from: number; to: number }[]; heads: number } {
  const asked: { from: number; to: number }[] = [];
  const chain = {
    asked,
    heads: 0,
    head: async () => {
      chain.heads++;
      return options.head;
    },
    logs: async ({ addresses, topic0s, from, to }: { addresses: readonly Address[]; topic0s: readonly Hex[]; from: number; to: number }) => {
      asked.push({ from, to });
      if (options.failCall === asked.length) throw new Error("ECONNRESET");
      if (options.maxSpan !== undefined && to - from + 1 > options.maxSpan) throw new RangeRefused();
      if (options.refuseBlock !== undefined && from <= options.refuseBlock && options.refuseBlock <= to) throw new RangeRefused();
      const wanted = new Set(addresses.map((a) => a.toLowerCase()));
      return (options.logs ?? []).filter((log) => {
        const block = Number(BigInt(log.blockNumber));
        return block >= from && block <= to && wanted.has(log.address.toLowerCase()) && topic0s.includes(log.topics[0]!);
      });
    },
  };
  return chain;
}

/** A report with `passes` passing checks out of eight, liquid or not. */
export function fakeReport(address: Address, passes: number, liquid: boolean, over: Partial<Report> = {}): Report {
  const ids = ["verified", "ownership", "privileges", "proxy", "holders", "liquidity", "lp-lock", "prevrandao"] as const;
  const others = ids.filter((id) => id !== "liquidity");
  const passing = new Set<string>(liquid ? ["liquidity", ...others.slice(0, Math.max(0, passes - 1))] : others.slice(0, passes));
  const findings = ids.map((id) => ({
    id,
    status: passing.has(id) ? ("pass" as const) : ("unknown" as const),
    title: id,
    detail: "",
    evidenceUrl: null,
    fixAppId: null,
  }));
  const pass = findings.filter((f) => f.status === "pass").length;
  return {
    address,
    network: "mainnet",
    token: { name: "Inspected", symbol: "INS", decimals: 18, totalSupply: "1000" },
    findings,
    passed: pass,
    total: findings.length,
    counts: { pass, warn: 0, fail: 0, unknown: findings.length - pass },
    explorerReachable: true,
    degraded: false,
    blockNumber: "23900000",
    generatedAt: "2026-10-02T00:00:00.000Z",
    ...over,
  };
}

export type InspectCall = { token: Address; extraPools: unknown[]; budget: ExplorerBudget | null };

/** An inspector that answers from `answers` by token (lowercase), spending `explorerCalls` of the budget each time. */
export function fakeInspector(
  answers: Record<string, { report: Report; scan?: PoolScan | null } | Error>,
  explorerCalls = 0,
): InspectToken & { calls: InspectCall[] } {
  const calls: InspectCall[] = [];
  const fn = (async (token, extraPools, budget) => {
    calls.push({ token, extraPools, budget });
    for (let i = 0; i < explorerCalls && budget; i++) budget.spend();
    const answer = answers[token.toLowerCase()];
    if (!answer) throw new Error("no fake answer");
    if (answer instanceof Error) throw answer;
    return { report: answer.report, scan: answer.scan ?? null };
  }) as InspectToken & { calls: InspectCall[] };
  fn.calls = calls;
  return fn;
}

/** A clock that moves only when told, in ms. */
export function fakeNow(start = Date.parse("2026-10-02T06:00:00Z")) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}
