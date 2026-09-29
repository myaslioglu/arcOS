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
 * `eth_call`, not just its own entry), so a call that throws has its calls split in two and retried, breadth-first —
 * every batch at one level is attempted before any failed one is split further (see `resilientAggregate`) — until
 * this budget runs out.
 */
export const MULTICALL_BUDGET = 16;
/**
 * No `aggregate3` attempt starts once this long has passed since the *lookup* began (not since the multicall itself
 * started: the explorer phase runs first, and both budgets are measured against the one clock `loadApprovals`
 * records before either phase, so a slow explorer phase can't let the multicall keep going past the route's 15 s
 * deadline on its own separate reckoning). The one exception is the very first `aggregate3` attempt, which always
 * starts regardless of the time already spent, so a clean lookup behind a slow explorer phase still gets its one
 * call. Whatever the halving hasn't resolved once the budget (this or MULTICALL_BUDGET) runs out counts as failed,
 * same as an ordinary revert, and marks the answer `truncated`.
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
/** `now`, when given, is the one clock `loadApprovals` measures both time budgets against; default `Date.now`. */
export type ApprovalsDeps = { readPage: LogsPageReader; aggregate: Aggregate; network: NetworkId; now?: () => number };

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
  now: () => number = Date.now,
  start: number = now(),
): Promise<{ logs: ExplorerLog[]; truncated: boolean }> {
  const seen = new Set<string>();
  const logs: ExplorerLog[] = [];
  let from = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (page > 0 && now() - start >= EXPLORER_TIME_BUDGET_MS) {
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

/** One `resilientAggregate` run's outcome, and the two facts needed to decide what it means for the lookup. */
type MulticallOutcome = { results: CallResult[]; anySucceeded: boolean; anyUnresolved: boolean };

/** A call neither answered nor attempted: `aggregate` never saw it, so it reads exactly like an on-chain revert. */
const UNRESOLVED: CallResult = { success: false, returnData: "0x" };

/** Whether `e` is the deadline's AbortController firing: the lookup was cancelled, not this one batch poisoned. */
function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

/** One batch mid-retry: its calls, and where they belong in the overall results array. */
type Batch = { calls: Call[]; offset: number };

/**
 * Splits one failed batch for a retry: by distinct `target` when more than one remains — the call list is ordered
 * token by token (see `liveApprovals`), so this isolates a whole poisoned token's calls to one side in a single
 * split, whatever the batch's size — or, once only one target is left, by plain index, so a token's own calls can
 * still be narrowed down individually (its allowance calls might resolve even where its metadata doesn't, or the
 * reverse).
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
 * makes exactly one `aggregate` call in total, at any depth.
 *
 * Every attempt draws from the one call `budget` (`MULTICALL_BUDGET`) and one time budget
 * (`MULTICALL_TIME_BUDGET_MS`, against the injectable `now`, counted from `start` — `loadApprovals`'s one clock for
 * the whole lookup, not from when this run itself started; `now`/`start` default to "right now" so a direct call
 * without either behaves as if the lookup just began) shared by the whole tree: both are checked before every
 * attempt, so once either runs out no further `aggregate` call is made — except the very first attempt, which
 * always starts regardless of the time already spent, so a clean lookup behind a slow explorer phase still gets its
 * one call. A one-call batch that fails, or any batch left unattempted when a budget runs out, resolves as
 * `UNRESOLVED` for each of its calls rather than failing the whole lookup — the caller decides what an unresolved
 * call means (`liveApprovals` drops it like a revert), and marks its answer `truncated` when `anyUnresolved` comes
 * back true. `anySucceeded` carries whether ANY attempt, anywhere in the tree, actually got an answer from the
 * chain: when it's false throughout, the caller still rejects, so an outage (or a poison too slow for the time
 * budget) is never read as "no approvals". An abort (the route's own 15 s deadline firing, checked by the
 * `aggregate` the caller supplies) is rethrown at once instead of being treated as a poisoned batch to isolate:
 * cancellation is a fact about the whole lookup, not about whichever batch happened to be in flight, so no further
 * attempt — not even an immediate one — follows it.
 */
async function resilientAggregate(
  calls: readonly Call[],
  aggregate: Aggregate,
  budget: { left: number },
  now: () => number = Date.now,
  start: number = now(),
): Promise<MulticallOutcome> {
  const results: CallResult[] = new Array(calls.length);
  let anySucceeded = false;
  let anyUnresolved = false;
  let attempted = false;
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
        anySucceeded = true;
      } catch (e) {
        if (isAbortError(e)) throw e;
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
  return { results, anySucceeded, anyUnresolved };
}

/** One call in `liveApprovals`'s multicall, and what it answers: a pair's allowance, or one token's metadata. */
type CallInfo = { kind: "allowance"; pair: ApprovalPair } | { kind: "symbol" | "name" | "decimals"; token: Address };

/**
 * The pairs still live: every pair's `allowance(owner, spender)` and each token's symbol, name and decimals, in one
 * multicall, its calls ordered token by token — each token's own allowance call(s) next to its own symbol, name and
 * decimals calls — so a poisoned token's calls stay together for `resilientAggregate` to isolate in one split.
 * Grouped by the token address **lowercased**, not by the address as each pair happens to spell it, so the same
 * contract's calls stay contiguous even if one Approval event's address arrived cased differently from another's.
 * A pair at zero drops out, and so does one whose allowance can't be read, or came back unresolved. Labels come from
 * contracts anyone can deploy, so they are cleaned (`cleanLabel`); a label or decimals that can't be read is null.
 * `truncated` is true only when some call came back unresolved — a pair legitimately reading zero, or a plain
 * revert from a well-behaved multicall, is not truncation. `now`/`start`, threaded through to `resilientAggregate`,
 * are injectable so a test can drive its time budget without waiting; by default `start` is "right now", so a
 * direct call without either behaves as if the lookup just began (matching how this function behaved before
 * `loadApprovals` grew a single clock for the whole lookup).
 */
export async function liveApprovals(
  owner: Address,
  pairs: readonly ApprovalPair[],
  aggregate: Aggregate,
  network: NetworkId,
  now: () => number = Date.now,
  start: number = now(),
): Promise<{ approvals: Approval[]; truncated: boolean }> {
  if (pairs.length === 0) return { approvals: [], truncated: false };
  const pairsByToken = new Map<string, ApprovalPair[]>();
  for (const p of pairs) {
    const key = p.token.toLowerCase();
    const list = pairsByToken.get(key);
    if (list) list.push(p);
    else pairsByToken.set(key, [p]);
  }
  const calls: Call[] = [];
  const info: CallInfo[] = [];
  for (const group of pairsByToken.values()) {
    const token = group[0]!.token;
    for (const p of group) {
      calls.push({
        target: p.token,
        callData: encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [owner, p.spender] }),
      });
      info.push({ kind: "allowance", pair: p });
    }
    calls.push({ target: token, callData: SYMBOL });
    info.push({ kind: "symbol", token });
    calls.push({ target: token, callData: NAME });
    info.push({ kind: "name", token });
    calls.push({ target: token, callData: DECIMALS });
    info.push({ kind: "decimals", token });
  }
  const { results, anySucceeded, anyUnresolved } = await resilientAggregate(calls, aggregate, { left: MULTICALL_BUDGET }, now, start);
  if (!anySucceeded) throw new ApprovalsUnavailable("The multicall could not complete.");
  const meta = new Map<string, { symbol: string | null; name: string | null; decimals: number | null }>();
  const allowanceByPair = new Map<ApprovalPair, bigint | undefined>();
  for (let i = 0; i < calls.length; i++) {
    const inf = info[i]!;
    if (inf.kind === "allowance") {
      const allowance = decoded(results[i], "allowance");
      allowanceByPair.set(inf.pair, typeof allowance === "bigint" ? allowance : undefined);
      continue;
    }
    const key = inf.token.toLowerCase();
    const current = meta.get(key) ?? { symbol: null, name: null, decimals: null };
    if (inf.kind === "symbol") {
      const symbol = decoded(results[i], "symbol");
      current.symbol = typeof symbol === "string" ? cleanLabel(symbol, 32) : null;
    } else if (inf.kind === "name") {
      const name = decoded(results[i], "name");
      current.name = typeof name === "string" ? cleanLabel(name, 64) : null;
    } else {
      const decimals = decoded(results[i], "decimals");
      current.decimals = typeof decimals === "number" && Number.isInteger(decimals) && decimals >= 0 && decimals <= 255 ? decimals : null;
    }
    meta.set(key, current);
  }
  const approvals = pairs.flatMap((p) => {
    const allowance = allowanceByPair.get(p);
    if (allowance === undefined || allowance === 0n) return [];
    const m = meta.get(p.token.toLowerCase()) ?? { symbol: null, name: null, decimals: null };
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

/**
 * The whole lookup: the explorer's logs, their pairs (at most MAX_PAIRS, the most recent), and what is still live.
 * One clock, `deps.now` (default `Date.now`), is recorded once here, before the explorer phase, and passed down to
 * both `collectApprovalLogs`'s EXPLORER_TIME_BUDGET_MS and `liveApprovals`'s MULTICALL_TIME_BUDGET_MS, so a slow
 * explorer phase counts against the multicall's own budget rather than each phase keeping its own separate clock.
 */
export async function loadApprovals(owner: Address, deps: ApprovalsDeps): Promise<ApprovalsAnswer> {
  const now = deps.now ?? Date.now;
  const start = now();
  const { logs, truncated: pagesTruncated } = await collectApprovalLogs(deps.readPage, now, start);
  const pairs = approvalPairs(owner, logs);
  const live = await liveApprovals(owner, pairs.slice(0, MAX_PAIRS), deps.aggregate, deps.network, now, start);
  return { approvals: live.approvals, truncated: pagesTruncated || pairs.length > MAX_PAIRS || live.truncated };
}
