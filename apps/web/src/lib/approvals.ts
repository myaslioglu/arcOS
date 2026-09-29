import {
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  isAddress,
  pad,
  type Address,
  type Hex,
} from "viem";
import { ARCOS, type NetworkId } from "@arcos/chain";
import { cleanLabel } from "@arcos/inspector";

/**
 * Revoke's list: an owner's live ERC-20 approvals. The explorer's logs module finds every Approval event the owner
 * emitted; the pairs they name are checked live on chain in one multicall, and the ones at zero drop out. Kept free
 * of "server-only" so every rule can be tested; approvals-server.ts wires it to the explorer and the RPC client.
 */

/** keccak256("Approval(address,address,uint256)"): the event ERC-20 (three topics) and ERC-721 (four) both emit. */
export const APPROVAL_TOPIC: Hex = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
/** The logs module answers at most this many logs a request (it has no page parameter)… */
export const LOGS_PAGE = 1000;
/** …and one lookup reads at most this many of them. */
export const MAX_PAGES = 5;
/** One lookup checks at most this many (token, spender) pairs, the most recent first, so its multicall stays bounded. */
export const MAX_PAIRS = 500;
/**
 * One lookup's multicall makes at most this many `aggregate3` calls in total. A clean lookup makes exactly one; a
 * spoofed Approval event can poison a whole call (a target whose fallback burns unbounded gas fails the entire
 * `eth_call`, not just its own entry), so a call that throws is retried as two half-sized calls, recursively, until
 * this budget runs out.
 */
export const MULTICALL_BUDGET = 16;
/** An allowance this large or larger reads "Unlimited": 2^255, half of uint256's range. */
export const UNLIMITED = 2n ** 255n;

/** Permit2's canonical address, the same on every chain. */
export const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/**
 * Circle App Kit's adapter contract: the spender Swap's approvals and permits name, since Swap has no router of its
 * own. From @circle-fin/app-kit 1.15.2 (ADAPTER_CONTRACT_EVM_MAINNET / ADAPTER_CONTRACT_EVM_TESTNET, used as the
 * chain's `kitContracts.adapter` by the stablecoin swap provider).
 */
export const SWAP_ADAPTER: Record<NetworkId, Address> = {
  mainnet: "0x7FB8c7260b63934d8da38aF902f87ae6e284a845",
  testnet: "0xBBD70b01a1CAbc96d5b7b129Ae1AAabdf50dd40b",
};

/** The explorer or the multicall couldn't answer: the route says "Couldn't load approvals". */
export class ApprovalsUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalsUnavailable";
  }
}

export type ExplorerLog = { address: Address; topics: Hex[]; blockNumber: number; logIndex: number; transactionHash: string };
export type ApprovalPair = { token: Address; spender: Address; lastApprovalBlock: number };
export type Approval = {
  token: Address;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  spender: Address;
  /** "Permit2", "4rc.OS Multisend", "Circle swap adapter", or null for a contract Revoke doesn't know. */
  spenderLabel: string | null;
  /** The live allowance, as a decimal string. */
  allowance: string;
  lastApprovalBlock: number;
};
export type ApprovalsAnswer = { approvals: Approval[]; truncated: boolean };
export type Call = { target: Address; callData: Hex };
export type CallResult = { success: boolean; returnData: Hex };
/** One Multicall3 aggregate3 call, each call allowed to fail on its own. It throws only when the call itself fails. */
export type Aggregate = (calls: readonly Call[]) => Promise<readonly CallResult[]>;
/** One page of the owner's Approval logs, from `fromBlock` on, as the explorer sent them. */
export type LogsPageReader = (fromBlock: number) => Promise<unknown[]>;
export type ApprovalsDeps = { readPage: LogsPageReader; aggregate: Aggregate; network: NetworkId };

export function isUnlimited(allowance: bigint): boolean {
  return allowance >= UNLIMITED;
}

/** The spenders Revoke can name; anything else is null, and the window reads it as "Unknown contract". */
export function spenderLabel(spender: string, network: NetworkId): string | null {
  const s = spender.toLowerCase();
  if (s === PERMIT2.toLowerCase()) return "Permit2";
  const multisend = ARCOS[network]?.multisend;
  if (multisend && s === multisend.toLowerCase()) return "4rc.OS Multisend";
  if (s === SWAP_ADAPTER[network].toLowerCase()) return "Circle swap adapter";
  return null;
}

/** One page of the logs module's getLogs: the owner's Approval events from `fromBlock` on. The key never goes in it. */
export function logsPageUrl(apiUrl: string, owner: Address, fromBlock: number): string {
  const query = new URLSearchParams({
    module: "logs",
    action: "getLogs",
    fromBlock: String(fromBlock),
    toBlock: "latest",
    topic0: APPROVAL_TOPIC,
    topic1: pad(owner.toLowerCase() as Hex, { size: 32 }),
    topic0_1_opr: "and",
  });
  return `${apiUrl}?${query.toString()}`;
}

/**
 * Reads one page. The key, when there is one, travels in the Authorization header as the Inspector sends it, never in
 * the URL, so no URL or error message can carry it. "No logs found" (status "0" with an empty list) is an empty page;
 * any other failure (an error status, a body that isn't JSON, one without a list) is an outage.
 */
export async function readLogsPage(url: string, fetchFn: typeof fetch, apiKey?: string): Promise<unknown[]> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const res = await fetchFn(url, { headers });
  if (!res.ok) throw new ApprovalsUnavailable(`The explorer answered ${res.status}.`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ApprovalsUnavailable("The explorer sent something that isn't JSON.");
  }
  const result = typeof body === "object" && body !== null ? (body as { result?: unknown }).result : undefined;
  if (!Array.isArray(result)) throw new ApprovalsUnavailable("The explorer answered without a list of logs.");
  // The logs module answers at most LOGS_PAGE logs a request; bounded again here so a misbehaving response can't
  // make collectApprovalLogs process an oversized page whole.
  return result.slice(0, LOGS_PAGE);
}

const HEX_NUMBER = /^0x[0-9a-fA-F]*$/;
const DECIMAL = /^\d+$/;
const TOPIC = /^0x[0-9a-fA-F]{64}$/;

/** A block number or log index as the explorer writes it: hex ("0x1a", and "0x" for 0) or decimal. */
function count(value: unknown): number | null {
  let n: number;
  if (typeof value === "number") n = value;
  else if (typeof value === "string" && HEX_NUMBER.test(value)) n = Number(BigInt(value === "0x" ? "0x0" : value));
  else if (typeof value === "string" && DECIMAL.test(value)) n = Number(value);
  else return null;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/**
 * One explorer log, or null when a field is missing or malformed. Blockscout pads `topics` with nulls up to four;
 * those are dropped, so the count left is the event's real topic count.
 */
export function readLog(raw: unknown): ExplorerLog | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.address !== "string" || !isAddress(o.address, { strict: false })) return null;
  if (!Array.isArray(o.topics) || typeof o.transactionHash !== "string") return null;
  const present: unknown[] = o.topics.filter((t) => t !== null && t !== "");
  if (!present.every((t) => typeof t === "string" && TOPIC.test(t))) return null;
  const blockNumber = count(o.blockNumber);
  const logIndex = count(o.logIndex);
  if (blockNumber === null || logIndex === null) return null;
  return {
    address: getAddress(o.address),
    topics: present as Hex[],
    blockNumber,
    logIndex,
    transactionHash: o.transactionHash.toLowerCase(),
  };
}

/** The address a 32-byte topic carries, or null when its top 12 bytes aren't zero (so it isn't one). */
export function topicAddress(topic: Hex): Address | null {
  return /^0x0{24}[0-9a-fA-F]{40}$/.test(topic) ? getAddress(`0x${topic.slice(26)}`) : null;
}

/**
 * Every Approval log the explorer holds for the owner, oldest first, from at most MAX_PAGES pages. The logs module has
 * no page parameter: it answers up to LOGS_PAGE logs from `fromBlock` on, so the next page starts at the last block a
 * full page reached (that block again, since a page can end partway through one), and a log seen twice is dropped.
 * `truncated` is true when the page cap stopped the scan (so the newest approvals may be missing), or when a single
 * block held a whole page.
 */
export async function collectApprovalLogs(readPage: LogsPageReader): Promise<{ logs: ExplorerLog[]; truncated: boolean }> {
  const seen = new Set<string>();
  const logs: ExplorerLog[] = [];
  let from = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const raw = await readPage(from);
    let last = from;
    for (const item of raw) {
      const log = readLog(item);
      if (!log) continue;
      last = Math.max(last, log.blockNumber);
      const key = `${log.transactionHash}:${log.logIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      logs.push(log);
    }
    if (raw.length < LOGS_PAGE) return { logs, truncated: false };
    if (last <= from) return { logs, truncated: true };
    from = last;
  }
  return { logs, truncated: true };
}

/**
 * The owner's (token, spender) pairs, each once, with its latest approval's block, newest first. Only ERC-20
 * approvals count: exactly three topics (ERC-721's Approval carries a fourth, the token id), the Approval event, the
 * owner as the first indexed argument, and a spender topic that is an address.
 */
export function approvalPairs(owner: Address, logs: readonly ExplorerLog[]): ApprovalPair[] {
  const pairs = new Map<string, ApprovalPair>();
  for (const log of logs) {
    if (log.topics.length !== 3) continue;
    if (log.topics[0].toLowerCase() !== APPROVAL_TOPIC) continue;
    if (topicAddress(log.topics[1])?.toLowerCase() !== owner.toLowerCase()) continue;
    const spender = topicAddress(log.topics[2]);
    if (!spender) continue;
    const key = `${log.address.toLowerCase()}:${spender.toLowerCase()}`;
    const known = pairs.get(key);
    if (!known || log.blockNumber > known.lastApprovalBlock) {
      pairs.set(key, { token: log.address, spender, lastApprovalBlock: log.blockNumber });
    }
  }
  return [...pairs.values()].sort((a, b) => b.lastApprovalBlock - a.lastApprovalBlock);
}

const SYMBOL = encodeFunctionData({ abi: erc20Abi, functionName: "symbol" });
const NAME = encodeFunctionData({ abi: erc20Abi, functionName: "name" });
const DECIMALS = encodeFunctionData({ abi: erc20Abi, functionName: "decimals" });

/** A call's decoded answer, or undefined when it failed, answered nothing, or answered something that doesn't decode. */
function decoded(result: CallResult | undefined, functionName: "allowance" | "symbol" | "name" | "decimals"): unknown {
  if (!result?.success || result.returnData === "0x") return undefined;
  try {
    return decodeFunctionResult({ abi: erc20Abi, functionName, data: result.returnData });
  } catch {
    return undefined;
  }
}

/** One `resilientAggregate` attempt's outcome, and the two facts needed to decide the next one. */
type MulticallOutcome = { results: CallResult[]; anySucceeded: boolean; anyUnresolved: boolean };

/** A call neither answered nor attempted: `aggregate` never saw it, so it reads exactly like an on-chain revert. */
const UNRESOLVED: CallResult = { success: false, returnData: "0x" };

/**
 * Calls `aggregate` with as many calls as it can. A clean call succeeds and this makes exactly one `aggregate` call
 * in total, at any depth. One that throws (a poisoned target's fallback burns unbounded gas and fails the whole
 * `eth_call`, not just its own entry) or answers the wrong number of results is retried as its calls split into two
 * halves, recursively, each drawing from the one `budget` shared by the whole tree: `budget.left` is checked before
 * every attempt, so once it runs out no further `aggregate` call is made. A one-call batch that fails, or any batch
 * left unattempted when the budget runs out, resolves as `UNRESOLVED` for each of its calls rather than failing the
 * whole lookup — the caller decides what an unresolved call means (liveApprovals drops it like a revert), and marks
 * its answer `truncated` when `anyUnresolved` comes back true. `anySucceeded` carries whether ANY attempt, anywhere
 * in the tree, actually got an answer from the chain: when it's false throughout, the caller still rejects, so an
 * outage is never read as "no approvals".
 */
async function resilientAggregate(calls: readonly Call[], aggregate: Aggregate, budget: { left: number }): Promise<MulticallOutcome> {
  if (budget.left <= 0) {
    return { results: calls.map(() => UNRESOLVED), anySucceeded: false, anyUnresolved: true };
  }
  budget.left -= 1;
  try {
    const results = await aggregate(calls);
    if (results.length !== calls.length) throw new ApprovalsUnavailable("The multicall answered the wrong number of results.");
    return { results: [...results], anySucceeded: true, anyUnresolved: false };
  } catch {
    if (calls.length === 1) {
      return { results: [UNRESOLVED], anySucceeded: false, anyUnresolved: true };
    }
    const mid = Math.ceil(calls.length / 2);
    const left = await resilientAggregate(calls.slice(0, mid), aggregate, budget);
    const right = await resilientAggregate(calls.slice(mid), aggregate, budget);
    return {
      results: [...left.results, ...right.results],
      anySucceeded: left.anySucceeded || right.anySucceeded,
      anyUnresolved: left.anyUnresolved || right.anyUnresolved,
    };
  }
}

/**
 * The pairs still live: every pair's `allowance(owner, spender)` and each token's symbol, name and decimals, in one
 * multicall (see `resilientAggregate` for how a poisoned target's calls are isolated rather than failing the whole
 * lookup). A pair at zero drops out, and so does one whose allowance can't be read, or came back unresolved. Labels
 * come from contracts anyone can deploy, so they are cleaned (`cleanLabel`); a label or decimals that can't be read
 * is null. `truncated` is true only when some call came back unresolved — a pair legitimately reading zero, or a
 * plain revert from a well-behaved multicall, is not truncation.
 */
export async function liveApprovals(
  owner: Address,
  pairs: readonly ApprovalPair[],
  aggregate: Aggregate,
  network: NetworkId,
): Promise<{ approvals: Approval[]; truncated: boolean }> {
  if (pairs.length === 0) return { approvals: [], truncated: false };
  const tokens = [...new Set(pairs.map((p) => p.token))];
  const calls: Call[] = [
    ...pairs.map((p) => ({
      target: p.token,
      callData: encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [owner, p.spender] }),
    })),
    ...tokens.flatMap((token) => [SYMBOL, NAME, DECIMALS].map((callData) => ({ target: token, callData }))),
  ];
  const { results, anySucceeded, anyUnresolved } = await resilientAggregate(calls, aggregate, { left: MULTICALL_BUDGET });
  if (!anySucceeded) throw new ApprovalsUnavailable("The multicall could not complete.");
  const meta = new Map(
    tokens.map((token, i) => {
      const at = pairs.length + i * 3;
      const symbol = decoded(results[at], "symbol");
      const name = decoded(results[at + 1], "name");
      const decimals = decoded(results[at + 2], "decimals");
      return [
        token,
        {
          symbol: typeof symbol === "string" ? cleanLabel(symbol, 32) : null,
          name: typeof name === "string" ? cleanLabel(name, 64) : null,
          decimals:
            typeof decimals === "number" && Number.isInteger(decimals) && decimals >= 0 && decimals <= 255 ? decimals : null,
        },
      ] as const;
    }),
  );
  const approvals = pairs.flatMap((p, i) => {
    const allowance = decoded(results[i], "allowance");
    if (typeof allowance !== "bigint" || allowance === 0n) return [];
    const m = meta.get(p.token) ?? { symbol: null, name: null, decimals: null };
    return [
      {
        token: p.token,
        symbol: m.symbol,
        name: m.name,
        decimals: m.decimals,
        spender: p.spender,
        spenderLabel: spenderLabel(p.spender, network),
        allowance: allowance.toString(),
        lastApprovalBlock: p.lastApprovalBlock,
      },
    ];
  });
  return { approvals, truncated: anyUnresolved };
}

/** The whole lookup: the explorer's logs, their pairs (at most MAX_PAIRS, the most recent), and what is still live. */
export async function loadApprovals(owner: Address, deps: ApprovalsDeps): Promise<ApprovalsAnswer> {
  const { logs, truncated } = await collectApprovalLogs(deps.readPage);
  const pairs = approvalPairs(owner, logs);
  const live = await liveApprovals(owner, pairs.slice(0, MAX_PAIRS), deps.aggregate, deps.network);
  return { approvals: live.approvals, truncated: truncated || pairs.length > MAX_PAIRS || live.truncated };
}
