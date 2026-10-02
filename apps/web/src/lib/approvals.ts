import {
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  isAddress,
  multicall3Abi,
  pad,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { ARCOS, PERMIT2, UNIVERSAL_ROUTERS, type NetworkId } from "@arcos/chain";
import { cleanLabel } from "@arcos/inspector";

/**
 * Revoke's list: an owner's live approvals of four kinds. ERC-20 allowances and single NFTs' approvals come from the
 * owner's Approval events (three topics and four); operators from their ApprovalForAll events (ERC-721 and ERC-1155
 * alike); Permit2 allowances from Permit2's own Approval and Permit events. The explorer's logs module finds the
 * events; what they name is checked live on chain in one multicall, and whatever is no longer set drops out. Kept
 * free of "server-only" so every rule can be tested; approvals-server.ts wires it to the explorer and the RPC client.
 */

/** keccak256("Approval(address,address,uint256)"): the event ERC-20 (three topics) and ERC-721 (four) both emit. */
export const APPROVAL_TOPIC: Hex = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
/** keccak256("ApprovalForAll(address,address,bool)"): ERC-721's and ERC-1155's operator event, the same in both. */
export const APPROVAL_FOR_ALL_TOPIC: Hex = "0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31";
/** keccak256("Approval(address,address,address,uint160,uint48)"): Permit2's own Approval (owner, token, spender). */
export const PERMIT2_APPROVAL_TOPIC: Hex = "0xda9fa7c1b00402c17d0161b249b1ab8bbec047c5a52207b9c112deffd817036b";
/** keccak256("Permit(address,address,address,uint160,uint48,uint48)"): a signed permit Permit2 accepted. */
export const PERMIT2_PERMIT_TOPIC: Hex = "0xc6a377bfc4eb120024a8ac08eef205be16b817020812c73223e81d1bdb9708ec";
/** The logs module answers at most this many logs a request (it has no page parameter)… */
export const LOGS_PAGE = 1000;
/** …and one lookup reads at most this many pages of Approval events… */
export const MAX_PAGES = 5;
/** …this many of ApprovalForAll events… */
export const OPERATOR_PAGES = 2;
/** …and this many of Permit2's events. */
export const PERMIT2_PAGES = 2;
/**
 * One lookup checks at most this many approvals of every kind together, the most recent first, so its multicall stays
 * bounded.
 */
export const MAX_PAIRS = 500;
/**
 * One lookup's multicall makes at most this many `aggregate3` calls in total. A clean lookup makes exactly one; a
 * spoofed Approval event can poison a whole call (a target whose fallback burns unbounded gas fails the entire
 * `eth_call`, not just its own entry), so a call that throws has its calls split in two and retried, breadth-first —
 * every batch at one level is attempted before any failed one is split further (see `resilientAggregate`) — until
 * this budget runs out. The canary's one read (see `Canary`) doesn't count against it.
 */
export const MULTICALL_BUDGET = 16;
/**
 * No `aggregate3` attempt starts once this long has passed since the *lookup* began (not since the multicall itself
 * started: the explorer phase runs first, and both budgets are measured against the one clock `loadApprovals`
 * records before either phase, so a slow explorer phase can't let the multicall keep going past the route's 15 s
 * deadline on its own separate reckoning). The one exception is the very first `aggregate3` attempt, which always
 * starts regardless of the time already spent, so a clean lookup behind a slow explorer phase still gets its one
 * call. Whatever the halving hasn't resolved once the budget (this or MULTICALL_BUDGET) runs out counts as failed,
 * same as an ordinary revert, and marks the answer `truncated`. That holds even when no attempt was answered at all,
 * as long as the canary (see `Canary`) has answered: the RPC is up, so the lookup returns what it has, an empty list
 * if need be, marked `truncated`. When the canary fails too, the RPC is down, and the lookup rejects instead (the
 * route answers 503).
 */
export const MULTICALL_TIME_BUDGET_MS = 9_000;
/**
 * No new explorer page starts once this long has passed since the lookup began — a spoofed Approval event can force
 * up to MAX_PAGES real pages for a victim, and each one costs a slow round trip. The first page always starts
 * regardless. Stopping early this way sets `truncated`, exactly as running out of MAX_PAGES does; the pages already
 * read are kept.
 */
export const EXPLORER_TIME_BUDGET_MS = 6_000;
/** An allowance this large or larger reads "Unlimited": 2^255, half of uint256's range. */
export const UNLIMITED = 2n ** 255n;

/**
 * Circle App Kit's adapter contract: the spender Swap's approvals and permits name, since Swap has no router of its
 * own. From @circle-fin/app-kit 1.15.2 (ADAPTER_CONTRACT_EVM_MAINNET / ADAPTER_CONTRACT_EVM_TESTNET, used as the
 * chain's `kitContracts.adapter` by the stablecoin swap provider).
 */
export const SWAP_ADAPTER: Record<NetworkId, Address> = {
  mainnet: "0x7FB8c7260b63934d8da38aF902f87ae6e284a845",
  testnet: "0xBBD70b01a1CAbc96d5b7b129Ae1AAabdf50dd40b",
};

/**
 * The explorer or the multicall couldn't answer: the route says "Couldn't load approvals". `status` is the HTTP status
 * the explorer answered with, when that is what failed (a 402 is Blockscout's PRO API saying the plan's quota or
 * payment is gone, a 429 its per-second limit, a 401 or 403 a refused key); null otherwise. The route logs it: a
 * number says which of these it was, and carries nothing of the key or the URL.
 */
export class ApprovalsUnavailable extends Error {
  constructor(
    message: string,
    public readonly status: number | null = null,
  ) {
    super(message);
    this.name = "ApprovalsUnavailable";
  }
}

export type ExplorerLog = { address: Address; topics: Hex[]; blockNumber: number; logIndex: number; transactionHash: string };
/**
 * What an approval is: an ERC-20 allowance, one NFT's approval (ERC-721 `approve`), an operator over a whole
 * collection (`setApprovalForAll`, ERC-721 or ERC-1155), or an allowance Permit2 keeps (`token` is what it moves).
 */
export type ApprovalKind = "erc20" | "erc721" | "operator" | "permit2";
/**
 * Where a candidate's latest event sits: its block, and its log index within that block. The pair functions always
 * set the index; a candidate built without one counts as the block's first log.
 */
type LatestEvent = { lastApprovalBlock: number; lastApprovalLogIndex?: number };
/** An ERC-20 (token, spender) pair the owner's Approval events name; `kind` is left out for these. */
export type ApprovalPair = { kind?: "erc20"; token: Address; spender: Address } & LatestEvent;
/** Something to check live: an ERC-20 pair, one NFT's approval, an operator, or a Permit2 allowance. */
export type Candidate =
  | ApprovalPair
  | ({ kind: "erc721"; token: Address; spender: Address; tokenId: bigint } & LatestEvent)
  | ({ kind: "operator" | "permit2"; token: Address; spender: Address } & LatestEvent);
export type Approval = {
  kind: ApprovalKind;
  token: Address;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  spender: Address;
  /** "Permit2", "Uniswap Universal Router", "4rc.OS Multisend", …, or null for a contract Revoke doesn't know. */
  spenderLabel: string | null;
  /**
   * The live allowance, as a decimal string: an amount for "erc20" and "permit2". An NFT approval and an operator
   * carry no amount, and read "1" (it is set).
   */
  allowance: string;
  /** "erc721" only: the NFT's id, as a decimal string. */
  tokenId?: string;
  /** "permit2" only: when Permit2 stops honouring the allowance, in unix seconds. */
  expiration?: number;
  lastApprovalBlock: number;
};
export type ApprovalsAnswer = { approvals: Approval[]; truncated: boolean };
export type Call = { target: Address; callData: Hex };
export type CallResult = { success: boolean; returnData: Hex };
/** One Multicall3 aggregate3 call, each call allowed to fail on its own. It throws only when the call itself fails. */
export type Aggregate = (calls: readonly Call[]) => Promise<readonly CallResult[]>;
/** One page of the owner's logs for one scan, from `fromBlock` on, as the explorer sent them. */
export type LogsPageReader = (fromBlock: number) => Promise<unknown[]>;
/** The three scans a lookup makes: Approval events, ApprovalForAll events, and Permit2's events. */
export type LogsScan = "approval" | "operator" | "permit2";
/**
 * One cheap read on the RPC client `aggregate` uses (approvals-server.ts asks Multicall3 for the block number, an
 * eth_call like `aggregate` itself), which tells an RPC outage from a poisoned multicall. A lookup asks it at most
 * once, and only when its first aggregate call fails: it answering means the RPC is up, so the calls themselves failed
 * and the halving goes on; it throwing means the RPC is down, and the lookup rejects. It counts against neither
 * MULTICALL_BUDGET nor MULTICALL_TIME_BUDGET_MS.
 */
export type Canary = () => Promise<unknown>;
/**
 * `now`, when given, is the one clock `loadApprovals` measures both time budgets against. Its default is
 * `performance.now()`, which, unlike `Date.now`, a wall-clock correction can't move mid-lookup.
 */
export type ApprovalsDeps = {
  /** The Approval scan: ERC-20 allowances and single NFTs' approvals. */
  readPage: LogsPageReader;
  /** The ApprovalForAll scan; left out, no operator is looked for. */
  readOperatorPage?: LogsPageReader;
  /** The Permit2 scan; left out, no Permit2 allowance is looked for. */
  readPermit2Page?: LogsPageReader;
  aggregate: Aggregate;
  canary: Canary;
  network: NetworkId;
  now?: () => number;
  /** Multicall3, asked for the block's timestamp so an expired Permit2 allowance drops out; left out, none does. */
  clock?: Address;
};

/** The default clock for both time budgets: monotonic, so a wall-clock step can neither stretch nor cut one. */
const monotonicNow = (): number => performance.now();

export function isUnlimited(allowance: bigint): boolean {
  return allowance >= UNLIMITED;
}

/** The spenders Revoke can name; anything else is null, and the window reads it as "Unknown contract". */
export function spenderLabel(spender: string, network: NetworkId): string | null {
  const s = spender.toLowerCase();
  if (s === PERMIT2.toLowerCase()) return "Permit2";
  if (UNIVERSAL_ROUTERS[network].some((r) => r.toLowerCase() === s)) return "Uniswap Universal Router";
  const multisend = ARCOS[network]?.multisend;
  if (multisend && s === multisend.toLowerCase()) return "4rc.OS Multisend";
  if (s === SWAP_ADAPTER[network].toLowerCase()) return "Circle swap adapter";
  return null;
}

/**
 * One page of the logs module's getLogs, from `fromBlock` on, for one scan: the owner's Approval events, their
 * ApprovalForAll events, or every event Permit2 emitted naming the owner first. The last asks for no topic0, so one
 * request brings Permit2's Approval and Permit events both (`permit2Pairs` keeps those two). The key never goes in it.
 */
export function logsPageUrl(apiUrl: string, owner: Address, fromBlock: number, scan: LogsScan = "approval"): string {
  const ownerTopic = pad(owner.toLowerCase() as Hex, { size: 32 });
  const common = { module: "logs", action: "getLogs", fromBlock: String(fromBlock), toBlock: "latest" };
  const query =
    scan === "permit2"
      ? new URLSearchParams({ ...common, address: PERMIT2, topic1: ownerTopic })
      : new URLSearchParams({
          ...common,
          topic0: scan === "operator" ? APPROVAL_FOR_ALL_TOPIC : APPROVAL_TOPIC,
          topic1: ownerTopic,
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
  if (!res.ok) throw new ApprovalsUnavailable(`The explorer answered ${res.status}.`, res.status);
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
 * Every Approval log the explorer holds for the owner, oldest first, from at most MAX_PAGES pages, and no page
 * started once EXPLORER_TIME_BUDGET_MS has passed since `start` (the first page always runs, whatever the time —
 * `now`/`start` default to "right now", so a direct call without either behaves as if it just began). The logs
 * module has no page parameter: it answers up to LOGS_PAGE logs from `fromBlock` on, so the next page starts at the
 * last block a full page reached (that block again, since a page can end partway through one), and a log seen twice
 * is dropped. `truncated` is true when the page cap or the time budget stopped the scan (so the newest approvals may
 * be missing), or when a single block held a whole page; the pages already read are kept either way.
 */
export async function collectApprovalLogs(
  readPage: LogsPageReader,
  now: () => number = monotonicNow,
  start: number = now(),
  maxPages: number = MAX_PAGES,
  firstPageAlways = true,
): Promise<{ logs: ExplorerLog[]; truncated: boolean }> {
  const seen = new Set<string>();
  const logs: ExplorerLog[] = [];
  let from = 0;
  for (let page = 0; page < maxPages; page++) {
    if ((page > 0 || !firstPageAlways) && now() - start >= EXPLORER_TIME_BUDGET_MS) {
      return { logs, truncated: true };
    }
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
 * Chain order, newest first: by block, then by log index within the block. Every kind decides which of a key's events
 * is the latest with it, and lists its candidates by it. The explorer's logs module answers in ascending (block, log
 * index) order, and pages overlap by a block (`collectApprovalLogs`), but nothing relies on that order: two events of
 * the same block, such as an NFT's approval cleared and set again, are told apart by their log index alone.
 */
export function newerFirst(a: LatestEvent, b: LatestEvent): number {
  return b.lastApprovalBlock - a.lastApprovalBlock || (b.lastApprovalLogIndex ?? 0) - (a.lastApprovalLogIndex ?? 0);
}

/**
 * The owner's (token, spender) pairs, each once, with its latest approval's block and log index, newest first. Only ERC-20
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
    const pair = { token: log.address, spender, lastApprovalBlock: log.blockNumber, lastApprovalLogIndex: log.logIndex };
    const known = pairs.get(key);
    if (!known || newerFirst(pair, known) < 0) pairs.set(key, pair);
  }
  return [...pairs.values()].sort(newerFirst);
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const isOwner = (t: Hex, owner: Address) => topicAddress(t)?.toLowerCase() === owner.toLowerCase();

/** Keeps, per key, the candidate from the latest event (block, then log index), and lists them newest first. */
function latestByKey<T extends LatestEvent>(items: Iterable<[string, T]>): T[] {
  const kept = new Map<string, T>();
  for (const [key, item] of items) {
    const known = kept.get(key);
    if (!known || newerFirst(item, known) < 0) kept.set(key, item);
  }
  return [...kept.values()].sort(newerFirst);
}

/**
 * The owner's single-NFT approvals: ERC-721's Approval, with four topics (the NFT's id is the fourth). One per NFT,
 * from its latest event by (block, log index), newest first. One whose latest event approves the zero address was
 * cleared, and drops out here rather than in the live check: every transfer out clears the approval with such an
 * event (OpenZeppelin's ERC-721 before 4.8.0), so a wallet that has sent many NFTs would otherwise spend MAX_PAIRS slots,
 * two reads each, on NFTs it no longer holds, and push live allowances out of the list. Nothing live is hidden by it:
 * an approval set after the clear is a later event, and is the one kept.
 */
export function nftApprovalPairs(owner: Address, logs: readonly ExplorerLog[]): Candidate[] {
  const found = function* (): Generator<[string, { kind: "erc721"; token: Address; spender: Address; tokenId: bigint; lastApprovalBlock: number; lastApprovalLogIndex: number }]> {
    for (const log of logs) {
      if (log.topics.length !== 4 || log.topics[0].toLowerCase() !== APPROVAL_TOPIC || !isOwner(log.topics[1], owner)) continue;
      const spender = topicAddress(log.topics[2]);
      if (!spender) continue;
      const tokenId = BigInt(log.topics[3]);
      yield [`${log.address.toLowerCase()}:${tokenId}`, { kind: "erc721", token: log.address, spender, tokenId, lastApprovalBlock: log.blockNumber, lastApprovalLogIndex: log.logIndex }];
    }
  };
  return latestByKey(found()).filter((c) => c.spender !== ZERO_ADDRESS);
}

/** The owner's operators: ApprovalForAll events (three topics), each collection and operator once, newest first. */
export function operatorPairs(owner: Address, logs: readonly ExplorerLog[]): Candidate[] {
  const found = function* (): Generator<[string, { kind: "operator"; token: Address; spender: Address; lastApprovalBlock: number; lastApprovalLogIndex: number }]> {
    for (const log of logs) {
      if (log.topics.length !== 3 || log.topics[0].toLowerCase() !== APPROVAL_FOR_ALL_TOPIC || !isOwner(log.topics[1], owner)) continue;
      const spender = topicAddress(log.topics[2]);
      if (!spender) continue;
      yield [`${log.address.toLowerCase()}:${spender.toLowerCase()}`, { kind: "operator", token: log.address, spender, lastApprovalBlock: log.blockNumber, lastApprovalLogIndex: log.logIndex }];
    }
  };
  return latestByKey(found());
}

/**
 * The owner's Permit2 allowances: Permit2's own Approval and Permit events (owner, token and spender are the three
 * indexed topics), each (token, spender) once, newest first. Only logs Permit2 itself emitted count: anyone can emit
 * an event with the same topics from a contract of their own.
 */
export function permit2Pairs(owner: Address, logs: readonly ExplorerLog[]): Candidate[] {
  const found = function* (): Generator<[string, { kind: "permit2"; token: Address; spender: Address; lastApprovalBlock: number; lastApprovalLogIndex: number }]> {
    for (const log of logs) {
      if (log.address.toLowerCase() !== PERMIT2.toLowerCase() || log.topics.length !== 4) continue;
      const event = log.topics[0].toLowerCase();
      if (event !== PERMIT2_APPROVAL_TOPIC && event !== PERMIT2_PERMIT_TOPIC) continue;
      if (!isOwner(log.topics[1], owner)) continue;
      const token = topicAddress(log.topics[2]);
      const spender = topicAddress(log.topics[3]);
      if (!token || !spender) continue;
      yield [`${token.toLowerCase()}:${spender.toLowerCase()}`, { kind: "permit2", token, spender, lastApprovalBlock: log.blockNumber, lastApprovalLogIndex: log.logIndex }];
    }
  };
  return latestByKey(found());
}

/** The reads an NFT approval and an operator are checked with. */
export const NFT_ABI = parseAbi([
  "function getApproved(uint256 tokenId) view returns (address)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
]);
/** Permit2's allowance read, and `lockdown`, which sets each named allowance to zero in one transaction. */
export const PERMIT2_ABI = parseAbi([
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function lockdown((address token, address spender)[] approvals)",
]);

const SYMBOL = encodeFunctionData({ abi: erc20Abi, functionName: "symbol" });
const NAME = encodeFunctionData({ abi: erc20Abi, functionName: "name" });
const DECIMALS = encodeFunctionData({ abi: erc20Abi, functionName: "decimals" });

const READ_ABIS = {
  erc20: erc20Abi,
  nft: NFT_ABI,
  permit2: PERMIT2_ABI,
  multicall3: multicall3Abi,
} as const;
type ReadFunction =
  | ["erc20", "allowance" | "symbol" | "name" | "decimals"]
  | ["nft", "getApproved" | "ownerOf" | "isApprovedForAll"]
  | ["permit2", "allowance"]
  | ["multicall3", "getCurrentBlockTimestamp"];

/** A call's decoded answer, or undefined when it failed, answered nothing, or answered something that doesn't decode. */
function decoded(result: CallResult | undefined, ...[abi, functionName]: ReadFunction): unknown {
  if (!result?.success || result.returnData === "0x") return undefined;
  try {
    return decodeFunctionResult({ abi: READ_ABIS[abi] as readonly unknown[], functionName, data: result.returnData } as never);
  } catch {
    return undefined;
  }
}

/** One `resilientAggregate` run's outcome: every call's result, and whether any of them is `UNRESOLVED`. */
type MulticallOutcome = { results: CallResult[]; anyUnresolved: boolean };

/** A call neither answered nor attempted: `aggregate` never saw it, so it reads exactly like an on-chain revert. */
const UNRESOLVED: CallResult = { success: false, returnData: "0x" };

/** Whether `e` is the deadline's AbortController firing: the lookup was cancelled, not this one batch poisoned. */
function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

/**
 * Asks the canary. It answering means the RPC is up. An abort stays an abort (the lookup was cancelled); any other
 * failure means the RPC is down, and the lookup rejects with ApprovalsUnavailable, so the route answers 503.
 */
async function confirmRpcAnswers(canary: Canary): Promise<void> {
  try {
    await canary();
  } catch (e) {
    if (isAbortError(e)) throw e;
    throw new ApprovalsUnavailable("The RPC isn't answering.");
  }
}

/** One batch mid-retry: its calls, and where they belong in the overall results array. */
type Batch = { calls: Call[]; offset: number };

/**
 * Splits one failed batch for a retry: by distinct `target` when more than one remains — the call list is ordered
 * token by token, oldest token first (see `liveApprovals`), so this isolates a whole poisoned token's calls to one
 * side in a single split, whatever the batch's size, and the left side, attempted first, holds the older tokens — or,
 * once only one target is left, by plain index, so a token's own calls can still be narrowed down individually (its
 * allowance calls might resolve even where its metadata doesn't, or the reverse).
 */
function splitBatch(calls: readonly Call[]): [Call[], Call[]] {
  const targets: string[] = [];
  const seen = new Set<string>();
  for (const c of calls) {
    const key = c.target.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      targets.push(key);
    }
  }
  if (targets.length > 1) {
    const firstHalf = new Set(targets.slice(0, Math.ceil(targets.length / 2)));
    const left: Call[] = [];
    const right: Call[] = [];
    for (const c of calls) (firstHalf.has(c.target.toLowerCase()) ? left : right).push(c);
    return [left, right];
  }
  const mid = Math.ceil(calls.length / 2);
  return [calls.slice(0, mid), calls.slice(mid)];
}

/**
 * Calls `aggregate` with as many calls as it can, breadth-first: every batch at one level is attempted before any
 * failed one is split further (see `splitBatch`), so the largest healthy batches get their turn early instead of
 * the retries spending their whole budget narrowing down one poisoned path first. A clean call succeeds and this
 * makes exactly one `aggregate` call in total, at any depth, and never asks the canary.
 *
 * When the first attempt fails, the canary is asked, once, before anything else is tried. If it fails too, the RPC is
 * down: this rejects with ApprovalsUnavailable, and nothing is split or retried. If it answers, the failure was the
 * calls' own (a poisoned target), and from then on no failed attempt can make this reject: whatever isn't answered
 * resolves as `UNRESOLVED`, even if that is every call.
 *
 * Every attempt draws from the one call `budget` (`MULTICALL_BUDGET`) and one time budget
 * (`MULTICALL_TIME_BUDGET_MS`, against the injectable `now`, counted from `start` — `loadApprovals`'s one clock for
 * the whole lookup, not from when this run itself started; `now`/`start` default to "right now" so a direct call
 * without either behaves as if the lookup just began) shared by the whole tree: both are checked before every
 * attempt, so once either runs out no further `aggregate` call is made — except the very first attempt, which
 * always starts regardless of the time already spent, so a clean lookup behind a slow explorer phase still gets its
 * one call. The canary counts against neither. A one-call batch that fails, or any batch left unattempted when a
 * budget runs out, resolves as `UNRESOLVED` for each of its calls rather than failing the whole lookup — the caller
 * decides what an unresolved call means (`liveApprovals` drops it like a revert), and marks its answer `truncated`
 * when `anyUnresolved` comes back true. An abort (the route's own 15 s deadline firing, checked by the `aggregate`
 * and the canary the caller supplies) is rethrown at once instead of being treated as a poisoned batch to isolate or
 * as an outage: cancellation is a fact about the whole lookup, not about whichever batch happened to be in flight,
 * so no further attempt — not even an immediate one — follows it.
 */
async function resilientAggregate(
  calls: readonly Call[],
  aggregate: Aggregate,
  canary: Canary,
  budget: { left: number },
  now: () => number = monotonicNow,
  start: number = now(),
): Promise<MulticallOutcome> {
  const results: CallResult[] = new Array(calls.length);
  let anyUnresolved = false;
  let attempted = false;
  let rpcAnswers = false;
  const deadline = start + MULTICALL_TIME_BUDGET_MS;
  let level: Batch[] = [{ calls: [...calls], offset: 0 }];
  while (level.length > 0) {
    const nextLevel: Batch[] = [];
    for (const batch of level) {
      if (attempted && (budget.left <= 0 || now() >= deadline)) {
        for (let i = 0; i < batch.calls.length; i++) results[batch.offset + i] = UNRESOLVED;
        anyUnresolved = true;
        continue;
      }
      attempted = true;
      budget.left -= 1;
      try {
        const batchResults = await aggregate(batch.calls);
        if (batchResults.length !== batch.calls.length) {
          throw new ApprovalsUnavailable("The multicall answered the wrong number of results.");
        }
        for (let i = 0; i < batchResults.length; i++) results[batch.offset + i] = batchResults[i];
      } catch (e) {
        if (isAbortError(e)) throw e;
        // The first attempt to fail is the first attempt: every later one exists only because it failed.
        if (!rpcAnswers) {
          await confirmRpcAnswers(canary);
          rpcAnswers = true;
        }
        if (batch.calls.length === 1) {
          results[batch.offset] = UNRESOLVED;
          anyUnresolved = true;
        } else {
          const [left, right] = splitBatch(batch.calls);
          nextLevel.push({ calls: left, offset: batch.offset });
          nextLevel.push({ calls: right, offset: batch.offset + left.length });
        }
      }
    }
    level = nextLevel;
  }
  return { results, anyUnresolved };
}

/** One call in `liveApprovals`'s multicall, and what it answers: a candidate's live state, a token's metadata, or the clock. */
type CallInfo =
  | { kind: "check"; candidate: Candidate; read: "allowance" | "getApproved" | "ownerOf" | "isApprovedForAll" | "permit2" }
  | { kind: "symbol" | "name" | "decimals"; token: Address }
  | { kind: "clock" };

/** A candidate's own checks: the calls that say whether it is still set. */
function checksOf(owner: Address, c: Candidate): { call: Call; read: Extract<CallInfo, { kind: "check" }>["read"] }[] {
  switch (c.kind) {
    case "erc721":
      return [
        { call: { target: c.token, callData: encodeFunctionData({ abi: NFT_ABI, functionName: "getApproved", args: [c.tokenId] }) }, read: "getApproved" },
        { call: { target: c.token, callData: encodeFunctionData({ abi: NFT_ABI, functionName: "ownerOf", args: [c.tokenId] }) }, read: "ownerOf" },
      ];
    case "operator":
      return [
        {
          call: { target: c.token, callData: encodeFunctionData({ abi: NFT_ABI, functionName: "isApprovedForAll", args: [owner, c.spender] }) },
          read: "isApprovedForAll",
        },
      ];
    case "permit2":
      return [
        {
          call: { target: PERMIT2, callData: encodeFunctionData({ abi: PERMIT2_ABI, functionName: "allowance", args: [owner, c.token, c.spender] }) },
          read: "permit2",
        },
      ];
    default:
      return [
        { call: { target: c.token, callData: encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [owner, c.spender] }) }, read: "allowance" },
      ];
  }
}

const CLOCK = encodeFunctionData({ abi: multicall3Abi, functionName: "getCurrentBlockTimestamp" });

/**
 * The candidates still set, in one multicall, its calls ordered token by token — each token's own checks next to its
 * own symbol, name and decimals calls — so a poisoned token's calls stay together for `resilientAggregate` to
 * isolate in one split. What each kind is checked with:
 * - an ERC-20 pair: `allowance(owner, spender)`, kept above zero;
 * - one NFT's approval: `getApproved(id)` and `ownerOf(id)`, kept while the owner still holds it and someone is
 *   approved (whoever is approved now is the row's spender);
 * - an operator: `isApprovedForAll(owner, operator)`, kept while true;
 * - a Permit2 allowance: Permit2's `allowance(owner, token, spender)`, kept above zero and, when `clock` (Multicall3)
 *   is given, until its expiry by the block's own timestamp, read once in the same multicall. When the timestamp
 *   can't be read, no allowance is dropped for its expiry: a live one is never hidden.
 * Grouped by the token address **lowercased**, not by the address as each candidate happens to spell it, so the same
 * contract's calls stay contiguous even if one event's address arrived cased differently from another's.
 * The tokens go oldest first, by each one's latest approval block: a spoofed event is fresh, so its token
 * sits at the end of the list, and at every level of the halving the older half, which holds the long-lived
 * approvals, is attempted before it. The answer keeps the order `pairs` came in, whatever order the calls went in.
 * A candidate whose check can't be read, or came back unresolved, drops out. Labels come from
 * contracts anyone can deploy, so they are cleaned (`cleanLabel`); a label or decimals that can't be read is null.
 * `truncated` is true only when some call came back unresolved — a pair legitimately reading zero, or a plain
 * revert from a well-behaved multicall, is not truncation. When the first multicall call fails, `canary` decides
 * between an outage (this rejects) and a poisoned call (the halving goes on; see `resilientAggregate`).
 * `now`/`start`, threaded through to `resilientAggregate`, are injectable so a test can drive its time budget
 * without waiting; by default `start` is "right now", so a direct call without either behaves as if the lookup just
 * began (matching how this function behaved before `loadApprovals` grew a single clock for the whole lookup).
 */
export async function liveApprovals(
  owner: Address,
  pairs: readonly Candidate[],
  aggregate: Aggregate,
  canary: Canary,
  network: NetworkId,
  now: () => number = monotonicNow,
  start: number = now(),
  clock?: Address,
): Promise<{ approvals: Approval[]; truncated: boolean }> {
  if (pairs.length === 0) return { approvals: [], truncated: false };
  const pairsByToken = new Map<string, Candidate[]>();
  for (const p of pairs) {
    const key = p.token.toLowerCase();
    const list = pairsByToken.get(key);
    if (list) list.push(p);
    else pairsByToken.set(key, [p]);
  }
  // Oldest first, by each token's latest approval block (a stable sort: a tie keeps the order the pairs came in).
  const tokensOldestFirst = [...pairsByToken.values()]
    .map((group) => ({ group, latest: Math.max(...group.map((p) => p.lastApprovalBlock)) }))
    .sort((a, b) => a.latest - b.latest)
    .map(({ group }) => group);
  const calls: Call[] = [];
  const info: CallInfo[] = [];
  // The clock first: it takes no argument anyone chose, so nothing can poison it.
  if (clock && pairs.some((p) => p.kind === "permit2")) {
    calls.push({ target: clock, callData: CLOCK });
    info.push({ kind: "clock" });
  }
  for (const group of tokensOldestFirst) {
    const token = group[0]!.token;
    for (const p of group) {
      for (const { call, read } of checksOf(owner, p)) {
        calls.push(call);
        info.push({ kind: "check", candidate: p, read });
      }
    }
    calls.push({ target: token, callData: SYMBOL });
    info.push({ kind: "symbol", token });
    calls.push({ target: token, callData: NAME });
    info.push({ kind: "name", token });
    calls.push({ target: token, callData: DECIMALS });
    info.push({ kind: "decimals", token });
  }
  const { results, anyUnresolved } = await resilientAggregate(calls, aggregate, canary, { left: MULTICALL_BUDGET }, now, start);
  const meta = new Map<string, { symbol: string | null; name: string | null; decimals: number | null }>();
  const checks = new Map<Candidate, Partial<Record<Extract<CallInfo, { kind: "check" }>["read"], unknown>>>();
  let blockTime: bigint | undefined;
  for (let i = 0; i < calls.length; i++) {
    const inf = info[i]!;
    if (inf.kind === "clock") {
      const t = decoded(results[i], "multicall3", "getCurrentBlockTimestamp");
      blockTime = typeof t === "bigint" ? t : undefined;
      continue;
    }
    if (inf.kind === "check") {
      const answer =
        inf.read === "allowance"
          ? decoded(results[i], "erc20", "allowance")
          : inf.read === "permit2"
            ? decoded(results[i], "permit2", "allowance")
            : decoded(results[i], "nft", inf.read);
      checks.set(inf.candidate, { ...checks.get(inf.candidate), [inf.read]: answer });
      continue;
    }
    const key = inf.token.toLowerCase();
    const current = meta.get(key) ?? { symbol: null, name: null, decimals: null };
    if (inf.kind === "symbol") {
      const symbol = decoded(results[i], "erc20", "symbol");
      current.symbol = typeof symbol === "string" ? cleanLabel(symbol, 32) : null;
    } else if (inf.kind === "name") {
      const name = decoded(results[i], "erc20", "name");
      current.name = typeof name === "string" ? cleanLabel(name, 64) : null;
    } else {
      const decimals = decoded(results[i], "erc20", "decimals");
      current.decimals = typeof decimals === "number" && Number.isInteger(decimals) && decimals >= 0 && decimals <= 255 ? decimals : null;
    }
    meta.set(key, current);
  }
  const approvals = pairs.flatMap((p): Approval[] => {
    const live = stillSet(owner, p, checks.get(p) ?? {}, blockTime);
    if (!live) return [];
    const m = meta.get(p.token.toLowerCase()) ?? { symbol: null, name: null, decimals: null };
    return [
      {
        kind: p.kind ?? "erc20",
        token: p.token,
        symbol: m.symbol,
        name: m.name,
        decimals: m.decimals,
        spender: live.spender,
        spenderLabel: spenderLabel(live.spender, network),
        allowance: live.allowance,
        ...(p.kind === "erc721" ? { tokenId: p.tokenId.toString() } : {}),
        ...(live.expiration !== undefined ? { expiration: live.expiration } : {}),
        lastApprovalBlock: p.lastApprovalBlock,
      },
    ];
  });
  return { approvals, truncated: anyUnresolved };
}

/** Whether a candidate is still set by its checks' answers, and what its row says if so; null when it isn't. */
function stillSet(
  owner: Address,
  c: Candidate,
  answers: Partial<Record<Extract<CallInfo, { kind: "check" }>["read"], unknown>>,
  blockTime: bigint | undefined,
): { spender: Address; allowance: string; expiration?: number } | null {
  switch (c.kind) {
    case "erc721": {
      const approved = answers.getApproved;
      const holder = answers.ownerOf;
      if (typeof approved !== "string" || typeof holder !== "string") return null;
      if (approved.toLowerCase() === ZERO_ADDRESS || holder.toLowerCase() !== owner.toLowerCase()) return null;
      return { spender: getAddress(approved), allowance: "1" };
    }
    case "operator":
      return answers.isApprovedForAll === true ? { spender: c.spender, allowance: "1" } : null;
    case "permit2": {
      const answer = answers.permit2;
      if (!Array.isArray(answer)) return null;
      const [amount, expiration] = answer as [unknown, unknown];
      if (typeof amount !== "bigint" || typeof expiration !== "number" || amount === 0n) return null;
      if (blockTime !== undefined && BigInt(expiration) < blockTime) return null;
      return { spender: c.spender, allowance: amount.toString(), expiration };
    }
    default: {
      const allowance = answers.allowance;
      return typeof allowance === "bigint" && allowance !== 0n ? { spender: c.spender, allowance: allowance.toString() } : null;
    }
  }
}

/** Whether `e` means the lookup was cancelled, which no partial answer may swallow. */
const cancelled = (e: unknown) => isAbortError(e) || (e instanceof Error && e.name === "AbortError");

/**
 * The whole lookup: the explorer's logs, then what they name (at most MAX_PAIRS, the most recent), then what is still
 * live. The scans run one after another, each page waited on before the next: Approval events (MAX_PAGES), then
 * ApprovalForAll events (OPERATOR_PAGES), then Permit2's (PERMIT2_PAGES). A clean lookup whose pages are all short
 * makes three explorer requests. One clock, `deps.now` (default `performance.now()`), is recorded once here, before
 * the explorer phase, and passed down to every scan's EXPLORER_TIME_BUDGET_MS and to `liveApprovals`'s
 * MULTICALL_TIME_BUDGET_MS, so a slow explorer phase counts against the multicall's own budget rather than each phase
 * keeping its own separate clock. Only the lookup's very first page is exempt from the time budget; a later scan
 * that finds it spent is skipped, and the answer is marked `truncated`. A later scan that fails does the same (the
 * Approval scan's list is still worth showing), while a failed Approval scan fails the lookup, and a cancellation
 * always propagates.
 */
export async function loadApprovals(owner: Address, deps: ApprovalsDeps): Promise<ApprovalsAnswer> {
  const now = deps.now ?? monotonicNow;
  const start = now();
  const { logs, truncated: pagesTruncated } = await collectApprovalLogs(deps.readPage, now, start);
  let scansTruncated = pagesTruncated;
  const later = async (readPage: LogsPageReader | undefined, maxPages: number): Promise<ExplorerLog[]> => {
    if (!readPage) return [];
    try {
      const scan = await collectApprovalLogs(readPage, now, start, maxPages, false);
      if (scan.truncated) scansTruncated = true;
      return scan.logs;
    } catch (e) {
      if (cancelled(e)) throw e;
      scansTruncated = true;
      return [];
    }
  };
  const operatorLogs = await later(deps.readOperatorPage, OPERATOR_PAGES);
  const permit2Logs = await later(deps.readPermit2Page, PERMIT2_PAGES);
  const candidates: Candidate[] = [
    ...approvalPairs(owner, logs),
    ...nftApprovalPairs(owner, logs),
    ...operatorPairs(owner, operatorLogs),
    ...permit2Pairs(owner, permit2Logs),
  ].sort(newerFirst);
  const live = await liveApprovals(
    owner,
    candidates.slice(0, MAX_PAIRS),
    deps.aggregate,
    deps.canary,
    deps.network,
    now,
    start,
    deps.clock,
  );
  return { approvals: live.approvals, truncated: scansTruncated || candidates.length > MAX_PAIRS || live.truncated };
}
