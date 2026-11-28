import { getAddress, isAddress } from "viem";
import type { InspectChain } from "@arcos/chain";
import type { CheckId, Finding, Report, Status } from "@arcos/inspector";

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

const STATUSES: readonly Status[] = ["pass", "warn", "fail", "unknown"];
const CHECKS: readonly CheckId[] = ["verified", "ownership", "privileges", "proxy", "holders", "liquidity", "lp-lock", "prevrandao", "trade"];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1_000;
const textOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";

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

/** `body` as a report of `address` on `chain`, or null when it isn't one. */
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
  if (!isRecord(counts) || !STATUSES.every((s) => isCount(counts[s]))) return null;
  if (!isCount(body.passed) || !isCount(body.total) || typeof body.explorerReachable !== "boolean" || typeof body.degraded !== "boolean") return null;
  if (body.explorerSkipped !== undefined && typeof body.explorerSkipped !== "string") return null;
  if (typeof body.blockNumber !== "string" || typeof body.generatedAt !== "string") return null;
  return {
    address: getAddress(body.address),
    network: body.network,
    chain: chain.key,
    chainId: chain.chainId,
    token: { name: token.name, symbol: token.symbol, decimals: token.decimals, totalSupply: token.totalSupply },
    findings: read as Finding[],
    passed: body.passed,
    total: body.total,
    counts: { pass: counts.pass as number, warn: counts.warn as number, fail: counts.fail as number, unknown: counts.unknown as number },
    explorerReachable: body.explorerReachable,
    ...(typeof body.explorerSkipped === "string" ? { explorerSkipped: body.explorerSkipped } : {}),
    degraded: body.degraded,
    blockNumber: body.blockNumber,
    generatedAt: body.generatedAt,
  };
}

/** What a refusal from the route means for the window. */
async function refusal(res: Response): Promise<ServerReportError> {
  if (res.status === 404) {
    // The route says which 404 it is: no contract at the address, or a chain this site doesn't read.
    const body: unknown = await res.json().catch(() => null);
    return new ServerReportError(isRecord(body) && body.error === NO_CONTRACT ? NO_CONTRACT : NOT_HERE);
  }
  if (res.status === 503) return new ServerReportError(BUSY);
  if (res.status === 429) return new ServerReportError(LIMITED);
  return new ServerReportError(UNREACHABLE);
}

/** The report of `address` on `chain`, from this site's server. Rejects with a `ServerReportError`. */
export async function serverReport(chain: Pick<InspectChain, "key" | "slug" | "chainId">, address: string, fetchFn: typeof fetch = fetch): Promise<Report> {
  let res: Response;
  try {
    res = await fetchFn(`/api/inspect/${chain.slug}/${address}`, { headers: { accept: "application/json" } });
  } catch {
    throw new ServerReportError(UNREACHABLE);
  }
  if (!res.ok) throw await refusal(res);
  const body: unknown = await res.json().catch(() => null);
  const report = asReport(body, chain, address);
  if (!report) throw new ServerReportError(UNREADABLE);
  return report;
}
