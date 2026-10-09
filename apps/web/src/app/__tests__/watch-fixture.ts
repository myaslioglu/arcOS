import { createHash, randomBytes } from "node:crypto";
import { expect, vi } from "vitest";
import { createPublicClient, custom, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { activeChain, type NetworkId } from "@arcos/chain";
import { FREE_WATCH_LIMIT, TTL_MS, type TimestampLike } from "@arcos/data";
import { nonceResponse, signatureVerifier, verifyResponse, type AuthDeps, type AuthStore } from "@/lib/auth-server";
import { buildSignInMessage, siteIdentity } from "@/lib/siwe";
import type { WatchDeps, WatchListing, WatchStore } from "@/lib/watch-server";

// What watch-routes.test.ts and telegram-routes.test.ts share: an in-memory store with the Firestore stores' rules
// (the real ones have their emulator suites in @arcos/data), deps over it, a real sign-in for the session cookie
// (lib/auth-server.ts's nonce and verify, with a key made for this run), and the request builders. Not a test file.

export const SITE = "https://4rcos.com";
export const SECRET = "watch-route-test-secret-".padEnd(48, "z");
/** 43 characters of A-Za-z0-9_-, the shape the owner's `openssl rand 32 | basenc --base64url` makes. */
export const WEBHOOK_SECRET = "watch-route-test-webhook-".padEnd(43, "w");
export const BOT_USERNAME = "arcos_watchdog_bot";
export const NOW = new Date("2026-10-09T12:00:00.000Z");
const NONCE_TTL_MS = 10 * 60_000;

export type User = { sessionVersion: number; telegram: { chatId: number } | null; watchCount: number };
export type Watch = { user: string; network: NetworkId; token: Address; createdAt: Date };
type LinkCode = { address: string; expiresAt: number };

/** The part of firebase-admin's Timestamp the listing carries, over a Date. */
export const timestamp = (date: Date): TimestampLike => ({
  seconds: Math.floor(date.getTime() / 1000),
  nanoseconds: (date.getTime() % 1000) * 1_000_000,
  toDate: () => date,
  toMillis: () => date.getTime(),
});

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("base64url");

export function memoryStore() {
  const nonces = new Map<string, { expiresAt: number }>();
  const users = new Map<string, User>();
  const watches = new Map<string, Watch>();
  /** tokens/{id}.symbol, as the index knows it. */
  const symbols = new Map<string, string | null>();
  /** The newest alert of a token, as the listing words it. */
  const alerts = new Map<string, NonNullable<WatchListing["latestAlert"]>>();
  const codes = new Map<string, LinkCode>();
  const watchKey = (user: string, network: NetworkId, token: string) => `${user.toLowerCase()}:${network}:${token.toLowerCase()}`;

  const auth: AuthStore = {
    async storeNonce(nonce, now) {
      if (nonces.has(nonce)) throw new Error("exists");
      nonces.set(nonce, { expiresAt: now.getTime() + NONCE_TTL_MS });
    },
    async isNonceLive(nonce, now) {
      const stored = nonces.get(nonce);
      return stored !== undefined && stored.expiresAt > now.getTime();
    },
    async acceptSignIn({ nonce, address, now }) {
      const stored = nonces.get(nonce);
      if (!stored) return { ok: false };
      nonces.delete(nonce);
      if (stored.expiresAt <= now.getTime()) return { ok: false };
      const key = address.toLowerCase();
      const user = users.get(key) ?? { sessionVersion: 0, telegram: null, watchCount: 0 };
      users.set(key, user);
      return { ok: true, sessionVersion: user.sessionVersion };
    },
    async readSessionState(address) {
      const user = users.get(address.toLowerCase());
      return user ? { sessionVersion: user.sessionVersion, telegramLinked: user.telegram !== null } : null;
    },
    async revokeSessions(address) {
      const user = users.get(address.toLowerCase());
      if (user) user.sessionVersion += 1;
    },
  };

  const watch: WatchStore = {
    async addWatch({ user, network, token, now }) {
      const key = user.toLowerCase();
      const doc = users.get(key);
      if (!doc) return { kind: "no-user" };
      if (watches.has(watchKey(key, network, token))) return { kind: "exists" };
      const count = [...watches.values()].filter((w) => w.user === key).length;
      if (count >= FREE_WATCH_LIMIT) return { kind: "limit" };
      watches.set(watchKey(key, network, token), { user: key, network, token: token.toLowerCase() as Address, createdAt: now });
      doc.watchCount = count + 1;
      return { kind: "added" };
    },
    async removeWatch({ user, network, token }) {
      const key = user.toLowerCase();
      if (!watches.delete(watchKey(key, network, token))) return { kind: "absent" };
      const doc = users.get(key);
      if (doc) doc.watchCount = Math.max(0, doc.watchCount - 1);
      return { kind: "removed" };
    },
    async listWatches(user, network) {
      const key = user.toLowerCase();
      return [...watches.values()]
        .filter((w) => w.user === key && w.network === network)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, 10)
        .map((w) => ({ token: w.token, symbol: symbols.get(w.token) ?? null, addedAt: timestamp(w.createdAt), latestAlert: alerts.get(w.token) ?? null }));
    },
    async createLinkCode(address, now) {
      const code = randomBytes(16).toString("base64url");
      codes.set(sha256(code), { address: address.toLowerCase(), expiresAt: now.getTime() + TTL_MS.linkCodes });
      return code;
    },
    async consumeLinkCode(code, chatId, now) {
      const stored = codes.get(sha256(code));
      if (!stored) return { ok: false };
      codes.delete(sha256(code));
      if (stored.expiresAt <= now.getTime()) return { ok: false };
      const user = users.get(stored.address);
      if (!user) return { ok: false };
      user.telegram = { chatId };
      return { ok: true, address: stored.address as Address };
    },
    async unlinkWallet(address) {
      const user = users.get(address.toLowerCase());
      if (user) user.telegram = null;
    },
    async unlinkChat(chatId) {
      let count = 0;
      for (const user of users.values()) {
        if (user.telegram?.chatId === chatId) {
          user.telegram = null;
          count += 1;
        }
      }
      return count;
    },
  };

  return { auth, watch, nonces, users, watches, symbols, alerts, codes };
}

export type Memory = ReturnType<typeof memoryStore>;

/** An RPC that never answers: an EOA's signature is checked locally, and no test here signs in a smart wallet. */
const rpcDown = createPublicClient({
  chain: activeChain(),
  transport: custom({
    async request() {
      throw new Error("rpc down");
    },
  }, { retryCount: 0 }),
});

export type Fixture = {
  memory: Memory;
  deps: WatchDeps;
  env: Record<string, string | undefined>;
  /** The clock every dep reads; a test moves it. */
  clock: { now: Date };
  /** What hasCode answers, or a rejection when it is an Error. */
  code: { answer: boolean | Error };
};

/** Fresh deps over a fresh store, configured for mainnet with every setting the routes need. */
export function fixture(): Fixture {
  const memory = memoryStore();
  const clock = { now: NOW };
  const code = { answer: true as boolean | Error };
  const env: Record<string, string | undefined> = {
    ARCOS_SESSION_SECRET: SECRET,
    NEXT_PUBLIC_SITE_URL: SITE,
    K_SERVICE: "arcos",
    TELEGRAM_BOT_USERNAME: BOT_USERNAME,
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
  };
  const auth: AuthDeps = { store: memory.auth, verifySignature: signatureVerifier(rpcDown), now: () => clock.now, env };
  const deps: WatchDeps = {
    store: memory.watch,
    auth,
    hasCode: async () => {
      if (code.answer instanceof Error) throw code.answer;
      return code.answer;
    },
    now: () => clock.now,
    env,
  };
  return { memory, deps, env, clock, code };
}

let clients = 0;
/** A client address no other test has used, so the per-client limits never carry over. */
export const freshIp = () => `203.0.113.${(clients += 1) % 250}`;

let sequence = 0;
/** A token address no other test has used. */
export const freshToken = (): Address => `0x${(sequence += 1).toString(16).padStart(40, "0")}`;

export type RequestInit2 = RequestInit & { origin?: string | null; cookie?: string | null; ip: string };

/** A request to `path` with the client's address, the site's Origin unless told otherwise, and the cookie given. */
export function request(path: string, init: RequestInit2): Request {
  const { origin = SITE, cookie, headers, ip, ...rest } = init;
  return new Request(`${SITE}${path}`, {
    ...rest,
    headers: {
      "x-real-ip": ip,
      ...(origin === null ? {} : { origin }),
      ...(cookie ? { cookie } : {}),
      ...(headers as Record<string, string> | undefined),
    },
  });
}

/** A JSON POST; a string body is sent as it is. */
export const postJson = (path: string, body: unknown, init: RequestInit2 & { contentType?: string }) =>
  request(path, {
    ...init,
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": init.contentType ?? "application/json", ...(init.headers as Record<string, string> | undefined) },
  });

const SESSION_COOKIE = "__Host-arcos_session";
const NONCE_COOKIE = "__Host-arcos_nonce";
const setCookieFor = (res: Response, name: string) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? null;

/**
 * Signs a wallet in the way the browser does (GET /api/auth/nonce, then POST /api/auth/verify over lib/auth-server.ts)
 * and returns its lowercase address and the session cookie to send.
 */
export async function signIn(fx: Fixture, ip: string, account = privateKeyToAccount(generatePrivateKey())) {
  const nonceRes = await nonceResponse(request("/api/auth/nonce", { origin: null, ip }), fx.deps.auth);
  expect(nonceRes.status).toBe(200);
  const { nonce } = (await nonceRes.json()) as { nonce: string };
  const jar = setCookieFor(nonceRes, NONCE_COOKIE)!.split(";")[0]!;
  const message = buildSignInMessage({ address: account.address, chainId: activeChain().id, nonce, site: siteIdentity(SITE)!, now: fx.clock.now });
  const signature = await account.signMessage({ message });
  const res = await verifyResponse(postJson("/api/auth/verify", { message, signature }, { ip, cookie: jar }), fx.deps.auth);
  expect(res.status).toBe(200);
  return { address: account.address.toLowerCase() as Address, cookie: setCookieFor(res, SESSION_COOKIE)!.split(";")[0]! };
}

/** The console, captured: every line of every level, joined, for the "logs hold nothing of the request" checks. */
export function captureConsole() {
  const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")].map((spy) => spy.mockImplementation(() => {}));
  return {
    lines: () => spies.flatMap((spy) => spy.mock.calls.map((call) => call.map(String).join(" "))),
    text: () => spies.flatMap((spy) => spy.mock.calls.map((call) => call.map(String).join(" "))).join("\n"),
  };
}
