import "server-only";
import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { activeNetwork, enabledInspectChain, type Address, type InspectChain, type InspectChainKey } from "@arcos/chain";
import type { Report } from "@arcos/inspector";
import { cachedInspection } from "./inspect-server";
import { isBusy, isChainNotEnabled, isNotAContract } from "./inspection-outcome";
import { processGlobal } from "./process-global";
import { badgeSvg } from "./proof";
import { clientKey, rateLimiter, type RateDecision } from "./rate-limit";
import { FAILED_INSPECTION_CACHE_CONTROL, reportCacheControl } from "./report-cache";

/**
 * What the Inspector's server routes share: /api/inspect, /badge and /t (the proof page and its social card), on Arc as
 * `/<route>/<address>` and on any other chain as `/<route>/<chain>/<address>`. Arc's answers are what they have always
 * been. Another chain answers only where this site reads it (on mainnet, and switched on by `NEXT_PUBLIC_INSPECT_CHAINS`),
 * and 404 everywhere else.
 *
 * Every inspection off Arc reads a paid RPC provider, so its /t and /badge (and the card) take a turn from a limiter per
 * client, as /api/inspect always has: 30 a minute. Without it, walking `/t/ethereum/<address>` over many addresses would
 * spend the provider's quota. Arc's /t and /badge stay unlimited, as before.
 */

/** 30 a minute per client, per server instance: /api/inspect, on every chain together (`clientKey`). */
const apiLimiter = () => processGlobal("inspect.apiLimiter", () => rateLimiter(30, 60_000));
/** The same for /t, its card and /badge off Arc, in a bucket of their own. */
const pageLimiter = () => processGlobal("inspect.pageLimiter", () => rateLimiter(30, 60_000));

/** A turn from the page limiter for the client these request headers name. */
export const takePageTurn = (headers: Pick<Headers, "get">): RateDecision => pageLimiter().take(clientKey(headers));

/** The chain a route's chain segment names, when this site reads it; null for anything else, Arc's slug included. */
export function routeChain(slug: string): InspectChain | null {
  const chain = enabledInspectChain(activeNetwork(), slug);
  return chain && chain.key !== "arc" ? chain : null;
}

const NO_STORE = { "cache-control": "no-store" } as const;
const NOT_HERE = "Not available on this network.";

/** 404 for a chain this site doesn't read: the same answer whether it is unknown, off, or another network's. */
export const chainNotFound = (): Response => NextResponse.json({ error: NOT_HERE }, { status: 404, headers: NO_STORE });

/**
 * One log line for an inspection that failed: what failed and the error's name only, the way the approvals and pulse
 * routes log, since a node's or an explorer's message could carry its URL. Off Arc the line names the chain too
 * ("inspect failed base TypeError"); Arc's lines read as they always have.
 */
const logFailure = (what: string, chain: InspectChainKey, e: unknown): void =>
  console.error(what, ...(chain === "arc" ? [] : [chain]), e instanceof Error ? e.name : "unknown");

/** GET /api/inspect/<address> (Arc) and /api/inspect/<chain>/<address>: the report as JSON. */
export async function inspectAnswer(req: Request, chain: InspectChainKey, address: string): Promise<Response> {
  if (!isAddress(address, { strict: false })) {
    return NextResponse.json({ error: "That isn't an address." }, { status: 400, headers: NO_STORE });
  }

  const decision = apiLimiter().take(clientKey(req.headers));
  if (!decision.ok) {
    return NextResponse.json(
      { error: "Too many requests. Try again shortly." },
      { status: 429, headers: { "retry-after": String(decision.retryAfterSec), ...NO_STORE } },
    );
  }

  try {
    const report = await cachedInspection(address, chain);
    return NextResponse.json(report, { headers: { "cache-control": reportCacheControl(report) } });
  } catch (e) {
    if (isNotAContract(e)) return NextResponse.json({ error: "No contract at that address." }, { status: 404 });
    if (isChainNotEnabled(e)) return chainNotFound();
    if (isBusy(e)) {
      return NextResponse.json(
        { error: "Inspector is busy. Try again in a few seconds." },
        { status: 503, headers: { "retry-after": "5", ...NO_STORE } },
      );
    }
    logFailure("inspect failed", chain, e);
    return NextResponse.json({ error: "Couldn't reach the network. Try again." }, { status: 502, headers: NO_STORE });
  }
}

const SVG = "image/svg+xml; charset=utf-8";

/** GET /badge/<address> (Arc) and /badge/<chain>/<address>: an SVG badge, neutral when there is no report. */
export async function badgeAnswer(req: Request, chain: InspectChainKey, address: string): Promise<Response> {
  let report: Report | null = null;
  let inspectionFailed = false;
  if (isAddress(address, { strict: false })) {
    if (chain !== "arc") {
      const decision = takePageTurn(req.headers);
      if (!decision.ok) {
        return new Response(badgeSvg(null), { status: 429, headers: { "content-type": SVG, "retry-after": String(decision.retryAfterSec), ...NO_STORE } });
      }
    }
    try {
      report = await cachedInspection(address as Address, chain);
    } catch (e) {
      inspectionFailed = true;
      // NotAContract (no token there), InspectorBusy and InspectionTimeout (both backpressure)
      // are expected outcomes, not failures worth an operator's attention.
      if (!isNotAContract(e) && !isBusy(e)) logFailure("badge inspect failed", chain, e);
    }
  }
  // A failed inspection (busy instance, network hiccup) isn't cached for five minutes like a
  // normal neutral badge — five seconds keeps the badge honest once capacity frees up. A degraded
  // report gets 30 seconds (see report-cache.ts).
  const cacheControl = inspectionFailed ? FAILED_INSPECTION_CACHE_CONTROL : reportCacheControl(report);
  return new Response(badgeSvg(report), { headers: { "content-type": SVG, "cache-control": cacheControl } });
}

/** What the proof page renders from: a report, no report (no contract, or not an address), or why there is none. */
export type ProofLoad = Report | null | "busy" | "error" | "limited";

/**
 * The proof page's report. Off Arc a client past its turns (`takePageTurn`, which the caller takes once per request)
 * gets "limited" and nothing is inspected.
 */
export async function proofLoad(chain: InspectChainKey, address: string, limited: () => Promise<boolean> = async () => false): Promise<ProofLoad> {
  if (!isAddress(address, { strict: false })) return null;
  if (chain !== "arc" && (await limited())) return "limited";
  try {
    return await cachedInspection(address as Address, chain);
  } catch (e) {
    if (isNotAContract(e)) return null;
    if (isBusy(e)) return "busy";
    logFailure("proof page inspect failed", chain, e);
    return "error";
  }
}

/** The social card's report, or null, and whether the inspection failed (which a CDN may keep 5 seconds only). */
export async function cardLoad(chain: InspectChainKey, address: string): Promise<{ report: Report | null; failed: boolean }> {
  if (!isAddress(address, { strict: false })) return { report: null, failed: false };
  try {
    return { report: await cachedInspection(address as Address, chain), failed: false };
  } catch (e) {
    // NotAContract (no token there), InspectorBusy and InspectionTimeout (both backpressure)
    // are expected outcomes, not failures worth an operator's attention.
    if (!isNotAContract(e) && !isBusy(e)) logFailure("og inspect failed", chain, e);
    return { report: null, failed: true };
  }
}

/** `cache-control` for the social card of `load`. */
export const cardCacheControl = (load: { report: Report | null; failed: boolean }): string =>
  load.failed ? FAILED_INSPECTION_CACHE_CONTROL : reportCacheControl(load.report);
