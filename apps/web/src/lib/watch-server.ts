import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { isAddress } from "viem";
import type { Address, NetworkId } from "@arcos/chain";
import { FREE_WATCH_LIMIT, TTL_MS, normalizeAddress, short, type AlertKind, type TimestampLike } from "@arcos/data";
import { requireSession, NOT_SIGNED_IN, type AuthDeps } from "./auth-server";
import { clientKey, rateLimiter } from "./rate-limit";
import { readBodyCapped } from "./read-body";
import { answer, dataGuard, errorCode, fail, isSiteOrigin, jsonContentType, tooMany } from "./route-kit";
import { sessionKey } from "./session";
import { siteIdentity, type SiteIdentity } from "./siwe";

// The Watchdog routes (design 5): a wallet's watch list and the Telegram link, behind the session cookie, and the bot's
// webhook, which Telegram calls server to server. The route files in app/api/watches/* and app/api/telegram/* only
// pass a request and watchDeps() (lib/watch-deps.ts) in here, so tests can run them over an in-memory store. The
// checks run in the order design 5 fixes, and every answer is no-store with `{ error: "<plain sentence>" }` on failure.
// Nothing here logs an address, a chat id, a link code, the webhook secret or a request's body: a failure logs one line
// naming the step, with an error's name and code at most.

/** The watch and link stores: @arcos/data/server's functions over Firestore in the app, an in-memory one in tests. */
export type WatchStore = {
  addWatch(input: { user: string; network: NetworkId; token: string; now: Date }): Promise<{ kind: "added" | "exists" | "limit" | "no-user" }>;
  removeWatch(input: { user: string; network: NetworkId; token: string }): Promise<{ kind: "removed" | "absent" }>;
  listWatches(user: string, network: NetworkId): Promise<WatchListing[]>;
  /** The code itself, stored only as a hash, valid for TTL_MS.linkCodes from `now`. */
  createLinkCode(address: string, now: Date): Promise<string>;
  /** Links the chat to the code's wallet, consuming the code whatever the outcome. */
  consumeLinkCode(code: string, chatId: number, now: Date): Promise<{ ok: true; address: Address } | { ok: false }>;
  unlinkWallet(address: string): Promise<void>;
  /** Takes every wallet off the chat; how many. */
  unlinkChat(chatId: number): Promise<number>;
};

/** One row as the store lists it (the shape of @arcos/data/server's WatchListing, named here so this module's type is its own). */
export type WatchListing = {
  token: Address;
  symbol: string | null;
  addedAt: TimestampLike;
  latestAlert: { kind: AlertKind; block: number; at: TimestampLike; text: string; link: string } | null;
};

export type WatchDeps = {
  store: WatchStore;
  /** What requireSession runs on: the sign-in store, the clock and the env with the session secret. */
  auth: AuthDeps;
  /** Whether a contract is deployed at the address, through the chain (lib/watch-deps.ts: eth_getCode, capped at 5 s). Throws when Arc can't be reached. */
  hasCode(address: Address): Promise<boolean>;
  now: () => Date;
  env: Readonly<Record<string, string | undefined>>;
};

/** One row as GET /api/watches answers it: dates as ISO strings, and never the watchers count. */
export type WatchRow = {
  token: Address;
  symbol: string | null;
  addedAt: string;
  latestAlert: { kind: AlertKind; block: number; at: string; text: string; link: string } | null;
};

/** The body of GET /api/watches, and of a POST or DELETE that changed the list. */
export type WatchesAnswer = { limit: number; watches: WatchRow[] };

/** Watches are on Arc mainnet only: the index the indexer checks them against holds mainnet data (design 0). */
const NETWORK: NetworkId = "mainnet";

const UNAVAILABLE = "Watchdog isn't available right now.";
const TELEGRAM_UNAVAILABLE = "Telegram alerts aren't available right now.";
const FOREIGN = "This request didn't come from this site.";
const INVALID = "The request isn't valid.";
const NOT_ADDRESS = "That isn't an address.";
const NO_CONTRACT = "No contract at that address.";
const NO_RPC = "Couldn't reach Arc. Try again in a minute.";
const LIMIT_REACHED = `You can watch up to ${FREE_WATCH_LIMIT} tokens. Remove one to add another.`;

/** A bot's username: letters, digits and underscores, 5 to 32 characters, ending in "bot" (Telegram's rule). */
const BOT_USERNAME = /^[A-Za-z][A-Za-z0-9_]{3,30}bot$/i;
/** The webhook secret: what setWebhook's secret_token takes (1 to 256 of A-Za-z0-9_-), at least 32 of them here. */
const WEBHOOK_SECRET = /^[A-Za-z0-9_-]{32,256}$/;
/** The header Telegram sends the secret in. */
const SECRET_HEADER = "x-telegram-bot-api-secret-token";
/** `/start <code>`, as the t.me link makes the client send it, with the 22-character code the link store issues. */
const START = /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{22})$/;
const STOP = /^\/stop(?:@\w+)?\s*$/;

/** `{ token }` is about 60 bytes. */
const MAX_WATCH_BODY_BYTES = 1024;
/** A Telegram update with one text message is under 1 KB; 16 KB leaves room for every field it may add. */
const MAX_WEBHOOK_BODY_BYTES = 16 * 1024;

// Per client and per server instance (lib/rate-limit.ts), one limiter a route, and one more per wallet on the writes.
const listLimiter = rateLimiter(60, 60_000);
const addLimiter = rateLimiter(20, 60_000);
const addWalletLimiter = rateLimiter(10, 60_000);
const removeLimiter = rateLimiter(20, 60_000);
const removeWalletLimiter = rateLimiter(10, 60_000);
const linkLimiter = rateLimiter(10, 60_000);
const linkWalletLimiter = rateLimiter(5, 10 * 60_000);
const unlinkLimiter = rateLimiter(10, 60_000);
/** Telegram's calls all come from Telegram: one key for the instance, then one per chat. */
const webhookLimiter = rateLimiter(300, 60_000);
const chatLimiter = rateLimiter(10, 60_000);
const WEBHOOK_KEY = "telegram";

const sha256 = (text: string): Buffer => createHash("sha256").update(text, "utf8").digest();

/** One line for a failed step: its name, and the error's name and code when it has them. Never the message. */
function logFailure(step: string, e?: unknown): void {
  const name = e instanceof Error ? e.name : undefined;
  const code = errorCode(e);
  console.error(JSON.stringify({ severity: "ERROR", message: "watchdog failed", step, ...(name ? { name } : {}), ...(code === undefined ? {} : { code }) }));
}

/** The site, when sign-in is configured (the session secret and the site address): what every route here needs first. */
function signInSite(env: WatchDeps["env"]): SiteIdentity | null {
  const site = siteIdentity(env.NEXT_PUBLIC_SITE_URL);
  return sessionKey(env.ARCOS_SESSION_SECRET) && site ? site : null;
}

const iso = (t: TimestampLike): string => t.toDate().toISOString();

const row = (w: WatchListing): WatchRow => ({
  token: w.token,
  symbol: w.symbol,
  addedAt: iso(w.addedAt),
  latestAlert: w.latestAlert ? { kind: w.latestAlert.kind, block: w.latestAlert.block, at: iso(w.latestAlert.at), text: w.latestAlert.text, link: w.latestAlert.link } : null,
});

/** The wallet's list as a response, or 503 when it can't be read. */
async function listAnswer(status: number, address: string, deps: WatchDeps): Promise<Response> {
  let watches: WatchListing[];
  try {
    watches = await deps.store.listWatches(address, NETWORK);
  } catch (e) {
    logFailure("list", e);
    return fail(503, UNAVAILABLE);
  }
  const body: WatchesAnswer = { limit: FREE_WATCH_LIMIT, watches: watches.map(row) };
  return answer(status, body);
}

/**
 * GET /api/watches: `{ limit, watches }` of the signed-in wallet. In order: the client's limit, the Origin (a GET from
 * the site itself usually carries none; one that names another site is refused), the configuration, the index guard,
 * the session, the list. The wallet only ever comes from the session.
 */
export async function listWatchesResponse(req: Request, deps: WatchDeps): Promise<Response> {
  const limit = listLimiter.take(clientKey(req.headers));
  if (!limit.ok) return tooMany(limit.retryAfterSec);
  const site = siteIdentity(deps.env.NEXT_PUBLIC_SITE_URL);
  const origin = req.headers.get("origin");
  if (origin !== null && (!site || origin !== site.uri)) return fail(403, FOREIGN);
  if (!signInSite(deps.env)) return fail(503, UNAVAILABLE);
  const guard = dataGuard(deps.env);
  if (guard) return guard;
  const session = await requireSession(req, deps.auth);
  if (session instanceof Response) return session;
  return listAnswer(200, session.address, deps);
}

/** The body of POST /api/watches, or null: a plain object with a string `token` and nothing else is read. */
function parseWatchBody(text: string): { token: string } | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const { token } = body as Record<string, unknown>;
  return typeof token === "string" ? { token } : null;
}

/**
 * POST /api/watches `{ token }`: watches the token. In order: the configuration, the index guard, the exact Origin, the
 * content type, the client's limit, the body (1 KB), its shape, the address, the session, the wallet's limit, that a
 * contract is deployed there (one RPC read), and the store's transaction: 201 with the list when added, 200 when the
 * wallet already watched it, 409 at the free limit, 401 for a wallet without a user doc.
 */
export async function addWatchResponse(req: Request, deps: WatchDeps): Promise<Response> {
  const site = signInSite(deps.env);
  if (!site) return fail(503, UNAVAILABLE);
  const guard = dataGuard(deps.env);
  if (guard) return guard;
  if (!isSiteOrigin(req, site)) return fail(403, FOREIGN);
  if (!jsonContentType(req)) return fail(415, INVALID);
  const limit = addLimiter.take(clientKey(req.headers));
  if (!limit.ok) return tooMany(limit.retryAfterSec);

  let text: string | null;
  try {
    text = await readBodyCapped(req, MAX_WATCH_BODY_BYTES);
  } catch {
    return fail(400, INVALID);
  }
  if (text === null) return fail(413, INVALID);
  const body = parseWatchBody(text);
  if (!body) return fail(400, INVALID);
  if (!isAddress(body.token, { strict: false })) return fail(400, NOT_ADDRESS);
  const token = normalizeAddress(body.token);

  const session = await requireSession(req, deps.auth);
  if (session instanceof Response) return session;
  const wallet = addWalletLimiter.take(session.address);
  if (!wallet.ok) return tooMany(wallet.retryAfterSec);

  let deployed: boolean;
  try {
    deployed = await deps.hasCode(token);
  } catch (e) {
    logFailure("code", e);
    return fail(503, NO_RPC);
  }
  if (!deployed) return fail(400, NO_CONTRACT);

  let added: Awaited<ReturnType<WatchStore["addWatch"]>>;
  try {
    added = await deps.store.addWatch({ user: session.address, network: NETWORK, token, now: deps.now() });
  } catch (e) {
    logFailure("add", e);
    return fail(503, UNAVAILABLE);
  }
  switch (added.kind) {
    case "added":
      return listAnswer(201, session.address, deps);
    case "exists":
      return listAnswer(200, session.address, deps);
    case "limit":
      return fail(409, LIMIT_REACHED);
    case "no-user":
      return fail(401, NOT_SIGNED_IN);
  }
}

/**
 * DELETE /api/watches/[token]: stops watching the token, and answers 200 with the list whether or not it was watched.
 * The same order as POST without the content type and the body: the configuration, the index guard, the exact
 * Origin, the client's limit, the address, the session, the wallet's limit, the store. The watch's id comes from the
 * session's wallet, so a wallet can only ever remove its own.
 */
export async function removeWatchResponse(req: Request, tokenParam: string, deps: WatchDeps): Promise<Response> {
  const site = signInSite(deps.env);
  if (!site) return fail(503, UNAVAILABLE);
  const guard = dataGuard(deps.env);
  if (guard) return guard;
  if (!isSiteOrigin(req, site)) return fail(403, FOREIGN);
  const limit = removeLimiter.take(clientKey(req.headers));
  if (!limit.ok) return tooMany(limit.retryAfterSec);
  if (typeof tokenParam !== "string" || !isAddress(tokenParam, { strict: false })) return fail(400, NOT_ADDRESS);
  const token = normalizeAddress(tokenParam);

  const session = await requireSession(req, deps.auth);
  if (session instanceof Response) return session;
  const wallet = removeWalletLimiter.take(session.address);
  if (!wallet.ok) return tooMany(wallet.retryAfterSec);

  try {
    await deps.store.removeWatch({ user: session.address, network: NETWORK, token });
  } catch (e) {
    logFailure("remove", e);
    return fail(503, UNAVAILABLE);
  }
  return listAnswer(200, session.address, deps);
}

/** The bot's username when it is configured and shaped like one; "none" (the testnet value) is not. */
function botUsername(env: WatchDeps["env"]): string | null {
  const name = env.TELEGRAM_BOT_USERNAME?.trim() ?? "";
  return BOT_USERNAME.test(name) ? name : null;
}

/**
 * POST /api/telegram/link: `{ url, expiresAt }`, a t.me link that opens the bot's chat with a fresh link code, good for
 * ten minutes. In order: the configuration (sign-in's, and the bot's username), the index guard, the exact Origin,
 * the client's limit, the session, the wallet's limit (5 in 10 minutes), the code. No body is read, nothing from the
 * request goes into the URL, and there is no redirect parameter anywhere.
 */
export async function linkTelegramResponse(req: Request, deps: WatchDeps): Promise<Response> {
  const site = signInSite(deps.env);
  const username = botUsername(deps.env);
  if (!site || !username) return fail(503, TELEGRAM_UNAVAILABLE);
  const guard = dataGuard(deps.env);
  if (guard) return guard;
  if (!isSiteOrigin(req, site)) return fail(403, FOREIGN);
  const limit = linkLimiter.take(clientKey(req.headers));
  if (!limit.ok) return tooMany(limit.retryAfterSec);
  const session = await requireSession(req, deps.auth);
  if (session instanceof Response) return session;
  const wallet = linkWalletLimiter.take(session.address);
  if (!wallet.ok) return tooMany(wallet.retryAfterSec);

  const now = deps.now();
  let code: string;
  try {
    code = await deps.store.createLinkCode(session.address, now);
  } catch (e) {
    logFailure("link", e);
    return fail(503, TELEGRAM_UNAVAILABLE);
  }
  const expiresAt = new Date(now.getTime() + TTL_MS.linkCodes).toISOString();
  return answer(200, { url: `https://t.me/${username}?start=${code}`, expiresAt });
}

/**
 * DELETE /api/telegram/link: takes the wallet's chat away, and answers 200 `{ telegram: "unlinked" }` whether or not
 * it had one. In order: the configuration (sign-in's: a bot that was renamed must not keep a wallet linked), the index
 * guard, the exact Origin, the client's limit, the session, the store.
 */
export async function unlinkTelegramResponse(req: Request, deps: WatchDeps): Promise<Response> {
  const site = signInSite(deps.env);
  if (!site) return fail(503, TELEGRAM_UNAVAILABLE);
  const guard = dataGuard(deps.env);
  if (guard) return guard;
  if (!isSiteOrigin(req, site)) return fail(403, FOREIGN);
  const limit = unlinkLimiter.take(clientKey(req.headers));
  if (!limit.ok) return tooMany(limit.retryAfterSec);
  const session = await requireSession(req, deps.auth);
  if (session instanceof Response) return session;
  try {
    await deps.store.unlinkWallet(session.address);
  } catch (e) {
    logFailure("unlink", e);
    return fail(503, TELEGRAM_UNAVAILABLE);
  }
  return answer(200, { telegram: "unlinked" });
}

/** The webhook's wordless answers: Telegram reads the status alone, and retries on anything but a 2xx. */
const empty = (status: number): Response => new Response(null, { status, headers: { "cache-control": "no-store" } });

/** A webhook update's one message, when it is a private text message from a person. Anything else is not answered. */
type PrivateMessage = { chatId: number; text: string };

function privateMessage(body: unknown): PrivateMessage | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const { message } = body as Record<string, unknown>;
  if (typeof message !== "object" || message === null || Array.isArray(message)) return null;
  const { chat, from, text } = message as Record<string, unknown>;
  if (typeof chat !== "object" || chat === null || Array.isArray(chat)) return null;
  const { id, type } = chat as Record<string, unknown>;
  if (type !== "private" || typeof id !== "number" || !Number.isSafeInteger(id)) return null;
  if (from !== undefined) {
    if (typeof from !== "object" || from === null || Array.isArray(from)) return null;
    if ((from as Record<string, unknown>).is_bot === true) return null;
  }
  if (typeof text !== "string") return null;
  return { chatId: id, text };
}

/** The reply a message gets, through the store: the link, /stop, or the one-line help. */
async function reply(message: PrivateMessage, deps: WatchDeps): Promise<string> {
  const start = START.exec(message.text);
  if (start) {
    const linked = await deps.store.consumeLinkCode(start[1]!, message.chatId, deps.now());
    return linked.ok
      ? `Linked. Watchdog alerts for ${short(linked.address)} will arrive in this chat. Send /stop to unlink.`
      : "This link has expired or was already used. Open Watchdog on 4rcos.com and choose Link Telegram again.";
  }
  if (STOP.test(message.text)) {
    const count = await deps.store.unlinkChat(message.chatId);
    console.log(JSON.stringify({ severity: "INFO", message: "telegram webhook", step: "stop", count }));
    return "Unlinked. This chat gets no more alerts.";
  }
  return "Open Watchdog on 4rcos.com, sign in, and choose Link Telegram.";
}

/**
 * POST /api/telegram/webhook: what Telegram calls with each update for the bot, server to server (no Origin, no
 * cookie). The reply rides in the response body as a Bot API method call, so the site never calls Telegram. In order:
 * the index guard; the secret (TELEGRAM_WEBHOOK_SECRET: 503 with an empty body on a mainnet server whose secret is
 * missing or malformed); the secret header, compared in constant time through SHA-256 digests, before any limiter, body read or
 * store call (401 empty); the instance's limit; the content type and the body (16 KB; 200 empty on anything else, and
 * on a body that isn't JSON); the message, which must be a private, non-bot text message with a safe-integer chat id
 * (200 empty otherwise); the chat's limit; then the commands. A store failure answers 500 with an empty body: the
 * transaction didn't commit, so Telegram's redelivery completes the link.
 */
export async function telegramWebhookResponse(req: Request, deps: WatchDeps): Promise<Response> {
  const guard = dataGuard(deps.env);
  if (guard) return guard;
  const secret = deps.env.TELEGRAM_WEBHOOK_SECRET ?? "";
  if (!WEBHOOK_SECRET.test(secret)) return empty(503);
  if (!timingSafeEqual(sha256(req.headers.get(SECRET_HEADER) ?? ""), sha256(secret))) return empty(401);

  if (!webhookLimiter.take(WEBHOOK_KEY).ok) {
    console.warn(JSON.stringify({ severity: "WARNING", message: "telegram webhook", step: "limited" }));
    return empty(200);
  }
  if (!jsonContentType(req)) return empty(200);
  let text: string | null;
  try {
    text = await readBodyCapped(req, MAX_WEBHOOK_BODY_BYTES);
  } catch {
    return empty(200);
  }
  if (text === null) return empty(200);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return empty(200);
  }
  const message = privateMessage(body);
  if (!message) return empty(200);
  if (!chatLimiter.take(sha256(String(message.chatId)).toString("base64url")).ok) return empty(200);

  let answerText: string;
  try {
    answerText = await reply(message, deps);
  } catch (e) {
    logFailure("store", e);
    return empty(500);
  }
  return answer(200, { method: "sendMessage", chat_id: message.chatId, text: answerText });
}
