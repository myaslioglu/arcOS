import { activeNetwork } from "@arcos/chain";
import { indexEnabled } from "./index-source";
import type { SiteIdentity } from "./siwe";

// What the routes behind a session share (lib/auth-server.ts, lib/watch-server.ts): the no-store answers, the 429, the
// Origin check against the configured site, the content-type check and the guard on the token index. Pure: no request
// is kept and nothing is logged. The network comes from activeNetwork() (process.env.NEXT_PUBLIC_ARC_NETWORK, which
// the route tests stub); only the index guard reads the env passed in, so a test passes the env it wants there.

export const NO_STORE = { "cache-control": "no-store" } as const;

/** A JSON answer that is never cached. */
export const answer = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers: { ...NO_STORE, ...headers } });

/** `{ error }` with a plain sentence, never cached. */
export const fail = (status: number, error: string, headers: Record<string, string> = {}): Response => answer(status, { error }, headers);

export const TOO_MANY = "Too many requests. Try again in a minute.";

/** 429 with a retry-after in seconds. */
export const tooMany = (retryAfterSec: number): Response => fail(429, TOO_MANY, { "retry-after": String(retryAfterSec) });

/**
 * A state-changing request must name this site as its Origin, as the configured site address spells it. A missing
 * Origin is refused too: every browser sends one on a POST. The Host and X-Forwarded-Host headers are never consulted.
 */
export function isSiteOrigin(req: Request, site: SiteIdentity): boolean {
  return req.headers.get("origin") === site.uri;
}

/** Whether the request says its body is JSON: the media type alone, whatever parameters follow it. */
export function jsonContentType(req: Request): boolean {
  return req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() === "application/json";
}

export const NOT_ON_THIS_NETWORK = "Not available on this network.";

/**
 * The routes over the token index (Firestore, mainnet data only: see `indexEnabled`) answer 404 anywhere else: on
 * testnet, on a dev server and in a CI build. Null when this server reads the index.
 */
export function dataGuard(env: Readonly<Record<string, string | undefined>>): Response | null {
  return activeNetwork() === "mainnet" && indexEnabled("mainnet", env) ? null : fail(404, NOT_ON_THIS_NETWORK);
}

/** An error's `code` when it is a number or a short word (a gRPC status, `ECONNRESET`), for a log line; never its message. */
export function errorCode(e: unknown): number | string | undefined {
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  if (typeof code === "number" && Number.isFinite(code)) return code;
  if (typeof code === "string" && /^[\w.-]{1,64}$/.test(code)) return code;
  return undefined;
}
