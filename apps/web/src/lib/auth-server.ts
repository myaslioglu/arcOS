import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isHex, type Client, type Hex } from "viem";
import { verifySiweMessage } from "viem/siwe";
import { activeChain } from "@arcos/chain";
import { clientKey, rateLimiter } from "./rate-limit";
import { readBodyCapped } from "./read-body";
import { checkSignInMessage, siteIdentity, type SiteIdentity } from "./siwe";
import {
  clearedNonceCookie,
  clearedSessionCookie,
  nonceCookie,
  readNonceCookie,
  readSession,
  readSessionCookie,
  sessionCookie,
  sessionKey,
  signSession,
} from "./session";

// The four sign-in routes (design 1.4 and 1.9) and getSession(), which every route behind a session calls. The routes
// in app/api/auth/* only pass a request and authDeps() (lib/auth-deps.ts) in here, so tests can run them over an
// in-memory store. Nothing here logs an address, a message, a signature, a cookie or the secret: a failure logs one
// line naming the step, and nothing of what the request carried.

/** The sign-in store: @arcos/data/server's functions over Firestore in the app, an in-memory one in tests. */
export type AuthStore = {
  storeNonce(nonce: string, now: Date): Promise<void>;
  /** Whether the nonce is stored and unexpired, without consuming it. acceptSignIn alone decides. */
  isNonceLive(nonce: string, now: Date): Promise<boolean>;
  acceptSignIn(input: { nonce: string; address: string; now: Date }): Promise<{ ok: true; sessionVersion: number } | { ok: false }>;
  readSessionState(address: string): Promise<{ sessionVersion: number; telegramLinked: boolean } | null>;
  revokeSessions(address: string): Promise<void>;
};

export type SignatureCheck = (input: { message: string; signature: Hex; now: Date }) => Promise<boolean>;

export type AuthDeps = {
  store: AuthStore;
  verifySignature: SignatureCheck;
  now: () => Date;
  env: Readonly<Record<string, string | undefined>>;
};

export type Session = { address: string };

type AuthConfig = { key: Uint8Array; site: SiteIdentity; chainId: number };

/**
 * Sign-in is on only with both settings: ARCOS_SESSION_SECRET (32 bytes or more) and NEXT_PUBLIC_SITE_URL, whose host
 * is the domain every message must name. Without either, every route answers 503 and getSession() null. There is no
 * default secret.
 */
function authConfig(env: AuthDeps["env"]): AuthConfig | null {
  const key = sessionKey(env.ARCOS_SESSION_SECRET);
  const site = siteIdentity(env.NEXT_PUBLIC_SITE_URL);
  if (!key || !site) {
    warnOnce(!key ? "session-secret-missing" : "site-url-missing");
    return null;
  }
  return { key, site, chainId: activeChain().id };
}

const warned = new Set<string>();
function warnOnce(reason: string) {
  if (warned.has(reason)) return;
  warned.add(reason);
  console.warn(JSON.stringify({ severity: "WARNING", message: "sign-in disabled", reason }));
}

/** One line for a failed step, with the step's name and nothing from the request or the error. */
const logFailure = (step: string) => console.error(JSON.stringify({ severity: "ERROR", message: "sign-in failed", step }));

// Per client and per server instance, like the other routes' limits (lib/rate-limit.ts).
const nonceLimiter = rateLimiter(20, 60_000);
const verifyLimiter = rateLimiter(10, 60_000);
const logoutLimiter = rateLimiter(20, 60_000);
const meLimiter = rateLimiter(60, 60_000);

/** A message is about 450 bytes and a signature at most a few KB (an ERC-6492 one carries a deploy call). */
const MAX_VERIFY_BODY_BYTES = 16 * 1024;
const MAX_SIGNATURE_LENGTH = 12 * 1024;

const NO_STORE = { "cache-control": "no-store" };
const answer = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
const fail = (status: number, error: string, headers: Record<string, string> = {}) => answer(status, { error }, headers);

const UNAVAILABLE = "Sign-in isn't available right now.";
const FOREIGN = "This request didn't come from this site.";
const INVALID = "The sign-in request isn't valid.";
const WRONG_MESSAGE = "The sign-in message isn't for this site or network, or has expired. Try again.";
const BAD_SIGNATURE = "The signature doesn't match this wallet.";
const EXPIRED = "This sign-in request has expired or was already used. Try again.";
const NOT_SIGNED_IN = "Not signed in.";
const tooMany = (retryAfterSec: number) =>
  fail(429, "Too many requests. Try again in a minute.", { "retry-after": String(retryAfterSec) });

/**
 * A state-changing request must name this site as its Origin, as the configured site address spells it. A missing
 * Origin is refused too: every browser sends one on a POST. The Host and X-Forwarded-Host headers are never consulted.
 */
function isSiteOrigin(req: Request, site: SiteIdentity): boolean {
  return req.headers.get("origin") === site.uri;
}

/** A 32-character hex nonce from the operating system's CSPRNG (viem's generateSiweNonce uses Math.random). */
const newNonce = () => randomBytes(16).toString("hex");

/** What the pre-auth cookie holds: the nonce's SHA-256, base64url. The nonce itself never goes in a cookie. */
const nonceHash = (nonce: string) => createHash("sha256").update(nonce).digest("base64url");

/**
 * Whether the request carries the pre-auth cookie of `nonce`, the one GET /api/auth/nonce set in this browser. It is
 * compared in constant time. So a nonce fetched in one browser can't sign in another.
 */
function isNonceOfThisBrowser(req: Request, nonce: string): boolean {
  const cookie = readNonceCookie(req.headers.get("cookie"));
  if (!cookie) return false;
  const given = Buffer.from(cookie);
  const expected = Buffer.from(nonceHash(nonce));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** GET /api/auth/nonce: `{ nonce }`, stored for 10 minutes, and its hash in the pre-auth cookie for as long. */
export async function nonceResponse(req: Request, deps: AuthDeps): Promise<Response> {
  const config = authConfig(deps.env);
  if (!config) return fail(503, UNAVAILABLE);
  // A GET from the site itself usually carries no Origin; one that names another site is refused.
  const origin = req.headers.get("origin");
  if (origin !== null && origin !== config.site.uri) return fail(403, FOREIGN);
  const limit = nonceLimiter.take(clientKey(req.headers));
  if (!limit.ok) return tooMany(limit.retryAfterSec);
  const nonce = newNonce();
  try {
    await deps.store.storeNonce(nonce, deps.now());
  } catch {
    logFailure("store-nonce");
    return fail(503, UNAVAILABLE);
  }
  return answer(200, { nonce }, { "set-cookie": nonceCookie(nonceHash(nonce)) });
}

/** The body of POST /api/auth/verify, or null. */
function parseVerifyBody(text: string): { message: string; signature: Hex } | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const { message, signature } = body as Record<string, unknown>;
  if (typeof message !== "string" || typeof signature !== "string") return null;
  if (signature.length > MAX_SIGNATURE_LENGTH || !isHex(signature, { strict: true }) || signature.length < 4) return null;
  return { message, signature };
}

/**
 * POST /api/auth/verify `{ message, signature }`: `{ address }` and a new session cookie. In order: the Origin, the
 * content type, the client's limit, the body, the message (lib/siwe.ts: this site's domain and URI from config, the
 * active chain, its lifetime), the pre-auth cookie (it must hold this nonce's hash), a read that the nonce is stored and
 * live (it consumes nothing, and spares the RPC a signature check for a nonce that can't sign in), the signature
 * (viem's verifySiweMessage, which covers EOAs and ERC-1271/6492 smart wallets), and last the nonce, which the store
 * accepts and deletes in one transaction. A new token is issued on every sign-in, whatever cookie the request carried. Every
 * answer clears the pre-auth cookie: the browser fetches a new nonce for its next try.
 */
export async function verifyResponse(req: Request, deps: AuthDeps): Promise<Response> {
  const config = authConfig(deps.env);
  if (!config) return fail(503, UNAVAILABLE);
  const res = await verifySignIn(req, deps, config);
  res.headers.append("set-cookie", clearedNonceCookie());
  return res;
}

async function verifySignIn(req: Request, deps: AuthDeps, config: AuthConfig): Promise<Response> {
  if (!isSiteOrigin(req, config.site)) return fail(403, FOREIGN);
  const type = req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") return fail(415, INVALID);
  const limit = verifyLimiter.take(clientKey(req.headers));
  if (!limit.ok) return tooMany(limit.retryAfterSec);

  let text: string | null;
  try {
    text = await readBodyCapped(req, MAX_VERIFY_BODY_BYTES);
  } catch {
    return fail(400, INVALID);
  }
  if (text === null) return fail(413, INVALID);
  const body = parseVerifyBody(text);
  if (!body) return fail(400, INVALID);

  const now = deps.now();
  const checked = checkSignInMessage(body.message, { site: config.site, chainId: config.chainId, now });
  if (!checked.ok) return fail(checked.reason === "malformed" ? 400 : 401, checked.reason === "malformed" ? INVALID : WRONG_MESSAGE);
  if (!isNonceOfThisBrowser(req, checked.nonce)) return fail(401, EXPIRED);

  let live: boolean;
  try {
    live = await deps.store.isNonceLive(checked.nonce, now);
  } catch {
    logFailure("read-nonce");
    return fail(503, UNAVAILABLE);
  }
  if (!live) return fail(401, EXPIRED);

  let valid: boolean;
  try {
    valid = await deps.verifySignature({ message: body.message, signature: body.signature, now });
  } catch {
    logFailure("verify-signature");
    return fail(502, "Couldn't check the signature right now. Try again.");
  }
  if (!valid) return fail(401, BAD_SIGNATURE);

  let accepted: Awaited<ReturnType<AuthStore["acceptSignIn"]>>;
  try {
    accepted = await deps.store.acceptSignIn({ nonce: checked.nonce, address: checked.address, now });
  } catch {
    logFailure("accept-sign-in");
    return fail(503, UNAVAILABLE);
  }
  if (!accepted.ok) return fail(401, EXPIRED);

  const token = await signSession({ address: checked.address, version: accepted.sessionVersion }, config.key, {
    audience: config.site.domain,
    now,
  });
  return answer(200, { address: checked.address }, { "set-cookie": sessionCookie(token) });
}

type ResolvedSession = Session & { telegramLinked: boolean };

/**
 * The session a request carries, checked against the store: the cookie must be this site's token, unexpired, and
 * signed at the user's current session version (signing out moves it on). Throws only when the store fails.
 */
async function resolveSession(req: Request, deps: AuthDeps, config: AuthConfig): Promise<ResolvedSession | null> {
  const token = readSessionCookie(req.headers.get("cookie"));
  if (!token) return null;
  const claims = await readSession(token, config.key, { audience: config.site.domain, now: deps.now() });
  if (!claims) return null;
  const state = await deps.store.readSessionState(claims.address);
  if (!state || state.sessionVersion !== claims.version) return null;
  return { address: claims.address, telegramLinked: state.telegramLinked };
}

/**
 * `{ address }` of the signed-in wallet, or null: no cookie, a cookie that doesn't count, or sign-in off. Routes behind
 * a session call it and answer 401 on null. Throws when the store can't be read, so a route can answer 503 rather than
 * sign the user out.
 */
export async function getSession(req: Request, deps: AuthDeps): Promise<Session | null> {
  const config = authConfig(deps.env);
  if (!config) return null;
  const session = await resolveSession(req, deps, config);
  return session ? { address: session.address } : null;
}

/** GET /api/auth/me: `{ address, telegram: "linked" | "unlinked" }`, or 401. */
export async function meResponse(req: Request, deps: AuthDeps): Promise<Response> {
  const config = authConfig(deps.env);
  if (!config) return fail(503, UNAVAILABLE);
  const limit = meLimiter.take(clientKey(req.headers));
  if (!limit.ok) return tooMany(limit.retryAfterSec);
  let session: ResolvedSession | null;
  try {
    session = await resolveSession(req, deps, config);
  } catch {
    logFailure("read-session");
    return fail(503, UNAVAILABLE);
  }
  if (!session) return fail(401, NOT_SIGNED_IN);
  return answer(200, { address: session.address, telegram: session.telegramLinked ? "linked" : "unlinked" });
}

/**
 * POST /api/auth/logout: 204 and a cleared cookie. It ends every session of the wallet (the version moves on), so a
 * copy of the cookie kept anywhere else stops counting too. Without a session it answers 401, and still clears the
 * cookie.
 */
export async function logoutResponse(req: Request, deps: AuthDeps): Promise<Response> {
  const cleared = { "set-cookie": clearedSessionCookie() };
  const config = authConfig(deps.env);
  if (!config) return fail(503, UNAVAILABLE, cleared);
  if (!isSiteOrigin(req, config.site)) return fail(403, FOREIGN);
  const limit = logoutLimiter.take(clientKey(req.headers));
  if (!limit.ok) return tooMany(limit.retryAfterSec);
  try {
    const session = await resolveSession(req, deps, config);
    if (!session) return fail(401, NOT_SIGNED_IN, cleared);
    await deps.store.revokeSessions(session.address);
  } catch {
    logFailure("logout");
    return fail(503, UNAVAILABLE);
  }
  return new Response(null, { status: 204, headers: { ...NO_STORE, ...cleared } });
}

/**
 * The signature check the app uses: viem's verifySiweMessage over `client`. An EOA's signature is recovered locally
 * when the RPC can't answer; a smart-contract wallet (ERC-1271, or ERC-6492 before it is deployed) is asked through
 * the RPC. The message itself was already checked by checkSignInMessage.
 */
export function signatureVerifier(client: Client): SignatureCheck {
  return ({ message, signature, now }) => verifySiweMessage(client, { message, signature, time: now });
}
