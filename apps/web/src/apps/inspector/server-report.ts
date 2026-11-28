import { getAddress, isAddress } from "viem";
import type { InspectChain } from "@arcos/chain";
import { DEADLINE_MS, type CheckId, type Finding, type Report, type Status } from "@arcos/inspector";

/**
 * The Inspector window's report for a chain other than Arc, from this site's server (`/api/inspect/<chain>/<address>`):
 * the browser never reads those chains itself, so no RPC key or explorer key reaches it. The answer is checked before the
 * window shows any of it, and an answer that isn't a report of that token on that chain is no report.
 */

/** Why there is no report, in the words the window shows. Never the server's own words. */
export class ServerReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerReportError";
  }
}

export const NO_CONTRACT = "No contract at that address.";
export const NOT_HERE = "Inspector doesn't read that chain on this site.";
export const BUSY = "Inspector is busy. Try again in a few seconds.";
export const LIMITED = "Too many requests. Try again in a minute.";
export const UNREACHABLE = "Couldn't reach the network. Try again.";
export const UNREADABLE = "Couldn't read the report. Try again.";

/**
 * How long the window waits for the server's answer: the server's own deadline for an inspection (DEADLINE_MS, 15 s,
 * past which it answers busy), and 10 s more for a cold start and the way there and back. A request still open by then
 * has stalled, and the window says it couldn't reach the network rather than ask the server forever.
 */
export const SERVER_TIMEOUT_MS = DEADLINE_MS + 10_000;

const STATUSES: readonly Status[] = ["pass", "warn", "fail", "unknown"];
const CHECKS: readonly CheckId[] = ["verified", "ownership", "privileges", "proxy", "holders", "liquidity", "lp-lock", "prevrandao", "trade"];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1_000;
const textOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";
/** A block number as a report gives it, and as the window shows it: digits, or "unknown". */
const isBlockNumber = (v: unknown): v is string => typeof v === "string" && /^(?:\d{1,20}|unknown)$/.test(v);
/** A report's `generatedAt`, an ISO time in UTC, of which the window shows the date and the minute. */
const isGeneratedAt = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/.test(v);

/** An evidence link the window may render: https only, so a link can never run script or leave for another scheme. */
function safeLink(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    return new URL(v).protocol === "https:" ? v : null;
  } catch {
    return null;
  }
}

function finding(v: unknown): Finding | null {
  if (!isRecord(v)) return null;
  const { id, status, title, detail } = v;
  if (!CHECKS.includes(id as CheckId) || !STATUSES.includes(status as Status) || typeof title !== "string" || typeof detail !== "string") return null;
  // Off Arc there is nothing to fix with Vault or Vesting, which are Arc's apps: the window shows no fix button there.
  return { id: id as CheckId, status: status as Status, title, detail, evidenceUrl: safeLink(v.evidenceUrl), fixAppId: null };
}

/**
 * `body` as a report of `address` on `chain`, or null when it isn't one. It must be a whole report, each check in it at
 * most once (as the engine reports them: a check twice would also be two rows with one key), and what the window shows
 * of the findings is counted from the findings themselves: `passed`, `total` and `counts` are never the body's own.
 */
export function asReport(body: unknown, chain: Pick<InspectChain, "key" | "chainId">, address: string): Report | null {
  if (!isRecord(body)) return null;
  const { token, findings, counts } = body;
  if (typeof body.address !== "string" || !isAddress(body.address, { strict: false })) return null;
  if (getAddress(body.address) !== getAddress(address) || body.chain !== chain.key || body.chainId !== chain.chainId) return null;
  if (body.network !== "mainnet" && body.network !== "testnet") return null;
  if (!isRecord(token) || !textOrNull(token.name) || !textOrNull(token.symbol) || !textOrNull(token.totalSupply)) return null;
  if (!(token.decimals === null || isCount(token.decimals))) return null;
  if (!Array.isArray(findings) || findings.length > CHECKS.length) return null;
  const read = findings.map(finding);
  if (read.some((f) => f === null)) return null;
  const checked = read as Finding[];
  if (new Set(checked.map((f) => f.id)).size !== checked.length) return null;
  if (!isRecord(counts) || !STATUSES.every((s) => isCount(counts[s]))) return null;
  if (!isCount(body.passed) || !isCount(body.total) || typeof body.explorerReachable !== "boolean" || typeof body.degraded !== "boolean") return null;
  if (body.explorerSkipped !== undefined && typeof body.explorerSkipped !== "string") return null;
  if (!isBlockNumber(body.blockNumber) || !isGeneratedAt(body.generatedAt)) return null;
  const count = (status: Status) => checked.filter((f) => f.status === status).length;
  const tally = { pass: count("pass"), warn: count("warn"), fail: count("fail"), unknown: count("unknown") };
  return {
    address: getAddress(body.address),
    network: body.network,
    chain: chain.key,
    chainId: chain.chainId,
    token: { name: token.name, symbol: token.symbol, decimals: token.decimals, totalSupply: token.totalSupply },
    findings: checked,
    passed: tally.pass,
    total: checked.length,
    counts: tally,
    explorerReachable: body.explorerReachable,
    ...(typeof body.explorerSkipped === "string" ? { explorerSkipped: body.explorerSkipped } : {}),
    degraded: body.degraded,
    blockNumber: body.blockNumber,
    generatedAt: body.generatedAt,
  };
}

/** What a refusal from the route means for the window, from its status and its body. */
function refusal(status: number, body: unknown): ServerReportError {
  // The route says which 404 it is: no contract at the address, or a chain this site doesn't read.
  if (status === 404) return new ServerReportError(isRecord(body) && body.error === NO_CONTRACT ? NO_CONTRACT : NOT_HERE);
  if (status === 503) return new ServerReportError(BUSY);
  if (status === 429) return new ServerReportError(LIMITED);
  return new ServerReportError(UNREACHABLE);
}

/** What `serverReport` takes besides the chain and the address: the caller's signal, and stand-ins for tests. */
export type ServerReportOptions = { signal?: AbortSignal; fetchFn?: typeof fetch; timeoutMs?: number };

/**
 * The report of `address` on `chain`, from this site's server. The request ends with `signal` (React Query's, which ends
 * when the window closes) or after `timeoutMs`, whichever comes first. Rejects with a `ServerReportError`, the timeout's
 * being UNREACHABLE, or, when `signal` ended the request, with that signal's reason, which is no answer to show.
 */
export async function serverReport(
  chain: Pick<InspectChain, "key" | "slug" | "chainId">,
  address: string,
  { signal, fetchFn = fetch, timeoutMs = SERVER_TIMEOUT_MS }: ServerReportOptions = {},
): Promise<Report> {
  const timeout = AbortSignal.timeout(timeoutMs);
  // The same pairing as lib/positions.ts's withDeadline: a browser without AbortSignal.any keeps the timeout alone.
  const ends = signal && typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : timeout;
  // A request cut short: by the caller, passed on as the caller's; by the timeout or the network, the network.
  const cutShort = (): unknown => (signal?.aborted ? signal.reason : new ServerReportError(UNREACHABLE));
  let res: Response;
  try {
    res = await fetchFn(`/api/inspect/${chain.slug}/${address}`, { headers: { accept: "application/json" }, signal: ends });
  } catch {
    throw cutShort();
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // An answer that isn't JSON is no report (null), unless the request was cut short while it was being read.
    if (ends.aborted) throw cutShort();
  }
  if (!res.ok) throw refusal(res.status, body);
  const report = asReport(body, chain, address);
  if (!report) throw new ServerReportError(UNREADABLE);
  return report;
}
