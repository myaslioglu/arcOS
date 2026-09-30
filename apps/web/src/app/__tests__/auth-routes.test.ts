import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, custom, type Hex } from "viem";
import { parseSiweMessage } from "viem/siwe";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { activeChain } from "@arcos/chain";
import type { AuthDeps, AuthStore } from "@/lib/auth-server";

// The four sign-in routes, end to end, over an in-memory store with the Firestore store's rules (the real store has its
// own emulator suite in @arcos/data) and a real signature check: viem's verifySiweMessage over a client whose RPC the
// test controls. Keys are made for this run only.

vi.mock("server-only", () => ({}));

const SITE = "https://4rcos.com";
const SECRET = "route-test-secret-".padEnd(48, "z");
const CHAIN_ID = activeChain().id;
const NONCE_TTL_MS = 10 * 60_000;

type Stored = { expiresAt: number };
type User = { sessionVersion: number; telegram: boolean };

function memoryStore() {
  const nonces = new Map<string, Stored>();
  const users = new Map<string, User>();
  const store: AuthStore = {
    async storeNonce(nonce, now) {
      if (nonces.has(nonce)) throw new Error("exists");
      nonces.set(nonce, { expiresAt: now.getTime() + NONCE_TTL_MS });
    },
    async acceptSignIn({ nonce, address, now }) {
      const stored = nonces.get(nonce);
      if (!stored) return { ok: false };
      nonces.delete(nonce);
      if (stored.expiresAt <= now.getTime()) return { ok: false };
      const key = address.toLowerCase();
      const user = users.get(key) ?? { sessionVersion: 0, telegram: false };
      users.set(key, user);
      return { ok: true, sessionVersion: user.sessionVersion };
    },
    async readSessionState(address) {
      const user = users.get(address.toLowerCase());
      return user ? { sessionVersion: user.sessionVersion, telegramLinked: user.telegram } : null;
    },
    async isNonceLive(nonce, now) {
      const stored = nonces.get(nonce);
      return stored !== undefined && stored.expiresAt > now.getTime();
    },
    async revokeSessions(address) {
      const user = users.get(address.toLowerCase());
      if (user) user.sessionVersion += 1;
    },
  };
  return { store, nonces, users };
}

/** What the RPC answers the smart-wallet check: the universal verifier's result, or a failure. */
let rpcAnswer: "valid" | "invalid" | "down" = "down";
const rpcCalls: string[] = [];
const client = createPublicClient({
  chain: activeChain(),
  transport: custom({
    async request({ method }: { method: string }) {
      rpcCalls.push(method);
      if (rpcAnswer === "down") throw new Error("rpc down");
      if (method === "eth_call") return rpcAnswer === "valid" ? `0x${"0".repeat(63)}1` : `0x${"0".repeat(64)}`;
      throw new Error(`unexpected ${method}`);
    },
  }, { retryCount: 0 }),
});

let memory: ReturnType<typeof memoryStore>;
let now: Date;
let deps: AuthDeps;
let env: Record<string, string | undefined>;

vi.mock("@/lib/auth-deps", () => ({ authDeps: () => deps }));

const { GET: nonceGET } = await import("@/app/api/auth/nonce/route");
const { POST: verifyPOST } = await import("@/app/api/auth/verify/route");
const { POST: logoutPOST } = await import("@/app/api/auth/logout/route");
const { GET: meGET } = await import("@/app/api/auth/me/route");
const { getSession, signatureVerifier } = await import("@/lib/auth-server");
const { buildSignInMessage, siteIdentity } = await import("@/lib/siwe");

let clients = 0;
/** A client address no other test has used, so the per-client limits never carry over. */
const freshIp = () => `203.0.113.${(clients += 1) % 250}`;
let ip: string;

/**
 * The browser's pre-auth cookie (review 1, Minor 1): the last one GET /api/auth/nonce set, sent with every request
 * the way a browser would. A test sets it to null to send none.
 */
let jar: string | null = null;

const request = (path: string, init: RequestInit & { origin?: string | null; cookie?: string } = {}) => {
  const { origin = SITE, cookie, headers, ...rest } = init;
  const cookies = [cookie, jar].filter(Boolean).join("; ");
  return new Request(`${SITE}${path}`, {
    ...rest,
    headers: {
      "x-real-ip": ip,
      ...(origin === null ? {} : { origin }),
      ...(cookies ? { cookie: cookies } : {}),
      ...(headers as Record<string, string> | undefined),
    },
  });
};

const NONCE_COOKIE = "__Host-arcos_nonce";
const nonceHash = (nonce: string) => createHash("sha256").update(nonce).digest("base64url");
/** Every Set-Cookie of a response, and the one that names `name`, if any. */
const setCookies = (res: Response) => res.headers.getSetCookie();
const setCookieFor = (res: Response, name: string) => setCookies(res).find((c) => c.startsWith(`${name}=`)) ?? null;

async function getNonce(): Promise<string> {
  const res = await nonceGET(request("/api/auth/nonce", { origin: null }));
  expect(res.status).toBe(200);
  jar = setCookieFor(res, NONCE_COOKIE)?.split(";")[0] ?? null;
  return ((await res.json()) as { nonce: string }).nonce;
}

const postJson = (path: string, body: unknown, init: { origin?: string | null; cookie?: string; contentType?: string } = {}) =>
  request(path, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    origin: init.origin,
    cookie: init.cookie,
    headers: { "content-type": init.contentType ?? "application/json" },
  });

const cookieOf = (res: Response) => setCookieFor(res, "arcos_session")?.split(";")[0] ?? null;

async function signIn(account = privateKeyToAccount(generatePrivateKey()), messageNow = now) {
  const nonce = await getNonce();
  const message = buildSignInMessage({
    address: account.address,
    chainId: CHAIN_ID,
    nonce,
    site: siteIdentity(SITE)!,
    now: messageNow,
  });
  const signature = await account.signMessage({ message });
  return { account, nonce, message, signature, res: await verifyPOST(postJson("/api/auth/verify", { message, signature })) };
}

let log: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
const everythingLogged = () => [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls].map((c) => c.map(String).join(" ")).join("\n");

beforeEach(() => {
  memory = memoryStore();
  now = new Date("2026-09-30T12:00:00.000Z");
  env = { ARCOS_SESSION_SECRET: SECRET, NEXT_PUBLIC_SITE_URL: SITE };
  rpcAnswer = "down";
  rpcCalls.length = 0;
  deps = { store: memory.store, verifySignature: signatureVerifier(client), now: () => now, env };
  ip = freshIp();
  jar = null;
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/auth/nonce", () => {
  it("answers { nonce }, not cached, and stores it", async () => {
    const res = await nonceGET(request("/api/auth/nonce", { origin: null }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { nonce: string };
    expect(Object.keys(body)).toEqual(["nonce"]);
    expect(body.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(memory.nonces.has(body.nonce)).toBe(true);
  });

  it("makes a different nonce every time", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10; i += 1) seen.add(await getNonce());
    expect(seen.size).toBe(10);
  });

  it("refuses a request another site started", async () => {
    const res = await nonceGET(request("/api/auth/nonce", { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(memory.nonces.size).toBe(0);
  });

  it("limits each client", async () => {
    let last: Response | undefined;
    for (let i = 0; i < 40; i += 1) last = await nonceGET(request("/api/auth/nonce", { origin: null }));
    expect(last?.status).toBe(429);
    expect(last?.headers.get("retry-after")).toMatch(/^\d+$/);
  });

  it("answers 503 with a clear error when the session secret is missing or too short, and stores nothing", async () => {
    for (const secret of [undefined, "", "too-short"]) {
      env.ARCOS_SESSION_SECRET = secret;
      const res = await nonceGET(request("/api/auth/nonce", { origin: null }));
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toMatch(/sign-in/i);
    }
    expect(memory.nonces.size).toBe(0);
  });

  it("answers 503 when the site address is not configured", async () => {
    env.NEXT_PUBLIC_SITE_URL = undefined;
    expect((await nonceGET(request("/api/auth/nonce", { origin: null }))).status).toBe(503);
  });

  it("answers 503 when the store fails, and logs no detail", async () => {
    memory.store.storeNonce = async () => {
      throw new Error("firestore said something about users/0xabc");
    };
    const res = await nonceGET(request("/api/auth/nonce", { origin: null }));
    expect(res.status).toBe(503);
    expect(everythingLogged()).not.toMatch(/0xabc|firestore said/);
  });
});

describe("POST /api/auth/verify", () => {
  it("signs an EOA in: answers { address } and sets the session cookie", async () => {
    const { account, res, nonce } = await signIn();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ address: account.address.toLowerCase() });
    const setCookie = setCookieFor(res, "arcos_session")!;
    expect(setCookie).toMatch(/^arcos_session=[\w-]+\.[\w-]+\.[\w-]+; Path=\/; Max-Age=604800; HttpOnly; Secure; SameSite=Lax$/);
    expect(memory.nonces.has(nonce)).toBe(false);
    expect(memory.users.has(account.address.toLowerCase())).toBe(true);
  });

  it("uses a nonce once: the same message and signature a second time are refused", async () => {
    const { message, signature, res } = await signIn();
    expect(res.status).toBe(200);
    const again = await verifyPOST(postJson("/api/auth/verify", { message, signature }));
    expect(again.status).toBe(401);
    expect(setCookieFor(again, "arcos_session")).toBeNull();
  });

  it("refuses a nonce the server never issued", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const message = buildSignInMessage({
      address: account.address,
      chainId: CHAIN_ID,
      nonce: "abcdefabcdefabcdefabcdefabcdefab",
      site: siteIdentity(SITE)!,
      now,
    });
    const res = await verifyPOST(postJson("/api/auth/verify", { message, signature: await account.signMessage({ message }) }));
    expect(res.status).toBe(401);
  });

  it("refuses a nonce older than 10 minutes", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const nonce = await getNonce();
    now = new Date(now.getTime() + NONCE_TTL_MS);
    const message = buildSignInMessage({ address: account.address, chainId: CHAIN_ID, nonce, site: siteIdentity(SITE)!, now });
    const res = await verifyPOST(postJson("/api/auth/verify", { message, signature: await account.signMessage({ message }) }));
    expect(res.status).toBe(401);
  });

  it("refuses a signature by another key, and keeps the nonce spent-free for the real signer", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const other = privateKeyToAccount(generatePrivateKey());
    const nonce = await getNonce();
    const message = buildSignInMessage({ address: account.address, chainId: CHAIN_ID, nonce, site: siteIdentity(SITE)!, now });
    const forged = await verifyPOST(postJson("/api/auth/verify", { message, signature: await other.signMessage({ message }) }));
    expect(forged.status).toBe(401);
    expect(setCookieFor(forged, "arcos_session")).toBeNull();
    const real = await verifyPOST(postJson("/api/auth/verify", { message, signature: await account.signMessage({ message }) }));
    expect(real.status).toBe(200);
  });

  it("refuses a message for another domain, URI or chain, whatever Host the request carries", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const cases = [
      { site: { domain: "evil.example", uri: SITE, scheme: "https" as const }, chainId: CHAIN_ID },
      { site: { domain: "4rcos.com", uri: "https://evil.example", scheme: "https" as const }, chainId: CHAIN_ID },
      { site: siteIdentity(SITE)!, chainId: CHAIN_ID + 1 },
    ];
    for (const { site, chainId } of cases) {
      const nonce = await getNonce();
      const message = buildSignInMessage({ address: account.address, chainId, nonce, site, now });
      const req = request("/api/auth/verify", {
        method: "POST",
        body: JSON.stringify({ message, signature: await account.signMessage({ message }) }),
        headers: { "content-type": "application/json", host: "evil.example", "x-forwarded-host": "evil.example" },
      });
      const res = await verifyPOST(req);
      expect(res.status).toBe(401);
      expect(memory.nonces.has(nonce)).toBe(true);
    }
    expect(memory.users.size).toBe(0);
  });

  it("refuses a request from another origin, or with none, before reading it", async () => {
    const { message, signature } = await (async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      const nonce = await getNonce();
      const msg = buildSignInMessage({ address: account.address, chainId: CHAIN_ID, nonce, site: siteIdentity(SITE)!, now });
      return { message: msg, signature: await account.signMessage({ message: msg }) };
    })();
    for (const origin of ["https://evil.example", "https://4rcos.com.evil.example", "http://4rcos.com", "null", null]) {
      const res = await verifyPOST(postJson("/api/auth/verify", { message, signature }, { origin }));
      expect(res.status, String(origin)).toBe(403);
    }
    // The request came through the site's own name: allowed.
    expect((await verifyPOST(postJson("/api/auth/verify", { message, signature }))).status).toBe(200);
  });

  it("refuses a body that is not JSON, or not { message, signature }", async () => {
    const plain = await verifyPOST(postJson("/api/auth/verify", "message=x", { contentType: "application/x-www-form-urlencoded" }));
    expect(plain.status).toBe(415);
    for (const body of ["not json", "[]", "{}", { message: 1, signature: "0x" }, { message: "x", signature: "nothex" }]) {
      const res = await verifyPOST(postJson("/api/auth/verify", body));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const huge = await verifyPOST(postJson("/api/auth/verify", { message: "x".repeat(20_000), signature: "0x" }));
    expect(huge.status).toBe(413);
  });

  it("verifies a smart-contract wallet (ERC-1271 / ERC-6492) through the RPC", async () => {
    const wallet = privateKeyToAccount(generatePrivateKey());
    const owner = privateKeyToAccount(generatePrivateKey());
    const nonce = await getNonce();
    const message = buildSignInMessage({ address: wallet.address, chainId: CHAIN_ID, nonce, site: siteIdentity(SITE)!, now });
    const signature = await owner.signMessage({ message });

    rpcAnswer = "invalid";
    expect((await verifyPOST(postJson("/api/auth/verify", { message, signature }))).status).toBe(401);
    expect(rpcCalls).toContain("eth_call");

    rpcAnswer = "valid";
    const res = await verifyPOST(postJson("/api/auth/verify", { message, signature }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ address: wallet.address.toLowerCase() });
  });

  it("answers 503 without the secret, and sets no cookie", async () => {
    const { message, signature } = await (async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      const nonce = await getNonce();
      const msg = buildSignInMessage({ address: account.address, chainId: CHAIN_ID, nonce, site: siteIdentity(SITE)!, now });
      return { message: msg, signature: await account.signMessage({ message: msg }) };
    })();
    env.ARCOS_SESSION_SECRET = undefined;
    const res = await verifyPOST(postJson("/api/auth/verify", { message, signature }));
    expect(res.status).toBe(503);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("limits each client", async () => {
    let last: Response | undefined;
    for (let i = 0; i < 15; i += 1) last = await verifyPOST(postJson("/api/auth/verify", {}));
    expect(last?.status).toBe(429);
  });

  it("never logs the address, the message, the signature or the secret", async () => {
    const { account, message, signature } = await signIn();
    memory.store.acceptSignIn = async () => {
      throw new Error(`boom for ${account.address}`);
    };
    const failing = await signIn(account);
    expect(failing.res.status).toBe(503);
    const logged = everythingLogged().toLowerCase();
    expect(logged).not.toContain(account.address.toLowerCase().slice(2));
    expect(logged).not.toContain(signature.slice(2, 40).toLowerCase());
    expect(logged).not.toContain(message.slice(0, 30).toLowerCase());
    expect(logged).not.toContain(SECRET.toLowerCase());
  });
});

// Review 1, Minor 1: a nonce counts only in the browser that fetched it. GET /api/auth/nonce sets a short-lived
// __Host- cookie holding the nonce's SHA-256; verify requires it to match the message's nonce, and clears it.
describe("the nonce's pre-auth cookie", () => {
  const CLEARED = `${NONCE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

  async function signed(nonce: string) {
    const account = privateKeyToAccount(generatePrivateKey());
    const message = buildSignInMessage({ address: account.address, chainId: CHAIN_ID, nonce, site: siteIdentity(SITE)!, now });
    return { account, message, signature: await account.signMessage({ message }) };
  }

  it("is set with the nonce: its SHA-256, HttpOnly, Secure, SameSite=Lax, Path=/, for 10 minutes", async () => {
    const res = await nonceGET(request("/api/auth/nonce", { origin: null }));
    const { nonce } = (await res.json()) as { nonce: string };
    expect(setCookies(res)).toEqual([
      `${NONCE_COOKIE}=${nonceHash(nonce)}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
    ]);
    expect(setCookies(res)[0]).not.toContain(nonce);
    expect(setCookies(res)[0]).not.toMatch(/domain=/i);
  });

  it("signs in with the matching cookie, and clears it", async () => {
    const nonce = await getNonce();
    const { account, message, signature } = await signed(nonce);
    const res = await verifyPOST(postJson("/api/auth/verify", { message, signature }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ address: account.address.toLowerCase() });
    expect(setCookieFor(res, "arcos_session")).toMatch(/^arcos_session=[\w-]+\.[\w-]+\.[\w-]+; /);
    expect(setCookieFor(res, NONCE_COOKIE)).toBe(CLEARED);
  });

  it("refuses a message without the cookie before checking the signature, keeps the nonce, and clears it", async () => {
    const verifySignature = vi.fn(deps.verifySignature);
    deps.verifySignature = verifySignature;
    const nonce = await getNonce();
    const { message, signature } = await signed(nonce);
    jar = null;
    const res = await verifyPOST(postJson("/api/auth/verify", { message, signature }));
    expect(res.status).toBe(401);
    expect(setCookieFor(res, "arcos_session")).toBeNull();
    expect(setCookieFor(res, NONCE_COOKIE)).toBe(CLEARED);
    expect(verifySignature).not.toHaveBeenCalled();
    expect(memory.nonces.has(nonce)).toBe(true);
  });

  it("refuses a nonce another browser fetched: the cookie is for a different nonce", async () => {
    const verifySignature = vi.fn(deps.verifySignature);
    deps.verifySignature = verifySignature;
    const victims = await getNonce();
    await getNonce(); // the attacker's browser holds the cookie of its own nonce
    const { message, signature } = await signed(victims);
    const res = await verifyPOST(postJson("/api/auth/verify", { message, signature }));
    expect(res.status).toBe(401);
    expect(setCookieFor(res, "arcos_session")).toBeNull();
    expect(verifySignature).not.toHaveBeenCalled();
    expect(memory.nonces.has(victims)).toBe(true);
  });

  it("refuses a cookie that isn't the hash, and two cookies of that name", async () => {
    const nonce = await getNonce();
    const { message, signature } = await signed(nonce);
    const good = jar!;
    for (const cookies of [`${NONCE_COOKIE}=${nonce}`, `${NONCE_COOKIE}=`, `${good}; ${good}`, `${good}; ${NONCE_COOKIE}=x`]) {
      jar = cookies;
      const res = await verifyPOST(postJson("/api/auth/verify", { message, signature }));
      expect(res.status, cookies).toBe(401);
    }
    jar = good;
    expect((await verifyPOST(postJson("/api/auth/verify", { message, signature }))).status).toBe(200);
  });
});

// Review 1, Important 1: a signature check can cost an RPC call, so verify first asks the store, without consuming
// anything, whether the nonce was issued and is still live. The accepting transaction stays the authority.
describe("the nonce check before the signature", () => {
  /** A message for `nonce`, signed, with this browser holding that nonce's pre-auth cookie. */
  async function attempt(nonce: string) {
    const account = privateKeyToAccount(generatePrivateKey());
    const message = buildSignInMessage({ address: account.address, chainId: CHAIN_ID, nonce, site: siteIdentity(SITE)!, now });
    jar = `${NONCE_COOKIE}=${nonceHash(nonce)}`;
    return { message, signature: await account.signMessage({ message }) };
  }

  let verifySignature: ReturnType<typeof vi.fn<AuthDeps["verifySignature"]>>;
  beforeEach(() => {
    verifySignature = vi.fn(deps.verifySignature);
    deps.verifySignature = verifySignature;
  });

  it("never hands an unknown nonce to the verifier", async () => {
    const res = await verifyPOST(postJson("/api/auth/verify", await attempt("abcdefabcdefabcdefabcdefabcdefab")));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toMatch(/expired or was already used/);
    expect(verifySignature).not.toHaveBeenCalled();
  });

  it("never hands a used or expired nonce to the verifier", async () => {
    const { message, signature, res } = await signIn();
    expect(res.status).toBe(200);
    expect(verifySignature).toHaveBeenCalledTimes(1);
    jar = `${NONCE_COOKIE}=${nonceHash(parseSiweMessage(message).nonce!)}`;
    expect((await verifyPOST(postJson("/api/auth/verify", { message, signature }))).status).toBe(401);

    const nonce = await getNonce();
    now = new Date(now.getTime() + NONCE_TTL_MS);
    expect((await verifyPOST(postJson("/api/auth/verify", await attempt(nonce)))).status).toBe(401);
    expect(verifySignature).toHaveBeenCalledTimes(1);
  });

  it("reads without consuming: a live nonce with a bad signature is still there for the real signer", async () => {
    const nonce = await getNonce();
    const { message } = await attempt(nonce);
    const other = privateKeyToAccount(generatePrivateKey());
    const forged = await verifyPOST(postJson("/api/auth/verify", { message, signature: await other.signMessage({ message }) }));
    expect(forged.status).toBe(401);
    expect(verifySignature).toHaveBeenCalledTimes(1);
    expect(memory.nonces.has(nonce)).toBe(true);
  });

  it("answers 503 when the store can't be read, without checking the signature", async () => {
    const nonce = await getNonce();
    memory.store.isNonceLive = async () => {
      throw new Error("firestore down");
    };
    const res = await verifyPOST(postJson("/api/auth/verify", await attempt(nonce)));
    expect(res.status).toBe(503);
    expect(verifySignature).not.toHaveBeenCalled();
  });

  it("still lets the accepting transaction decide: a nonce used between the check and the accept is refused", async () => {
    const nonce = await getNonce();
    const { message, signature } = await attempt(nonce);
    memory.store.isNonceLive = async () => true;
    memory.nonces.delete(nonce);
    const res = await verifyPOST(postJson("/api/auth/verify", { message, signature }));
    expect(res.status).toBe(401);
    expect(setCookieFor(res, "arcos_session")).toBeNull();
  });
});

describe("GET /api/auth/me", () => {
  it("answers { address, telegram } for a signed-in wallet", async () => {
    const { account, res } = await signIn();
    const me = await meGET(request("/api/auth/me", { origin: null, cookie: cookieOf(res)! }));
    expect(me.status).toBe(200);
    expect(me.headers.get("cache-control")).toBe("no-store");
    expect(await me.json()).toEqual({ address: account.address.toLowerCase(), telegram: "unlinked" });

    memory.users.get(account.address.toLowerCase())!.telegram = true;
    const linked = await meGET(request("/api/auth/me", { origin: null, cookie: cookieOf(res)! }));
    expect(await linked.json()).toEqual({ address: account.address.toLowerCase(), telegram: "linked" });
  });

  it("answers 401 without a cookie, with a forged one, or after seven days", async () => {
    expect((await meGET(request("/api/auth/me", { origin: null }))).status).toBe(401);
    expect((await meGET(request("/api/auth/me", { origin: null, cookie: "arcos_session=a.b.c" }))).status).toBe(401);
    const { res } = await signIn();
    now = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
    expect((await meGET(request("/api/auth/me", { origin: null, cookie: cookieOf(res)! }))).status).toBe(401);
  });

  it("answers 401 for a session signed with an earlier secret", async () => {
    const { res } = await signIn();
    env.ARCOS_SESSION_SECRET = "a-rotated-secret-".padEnd(48, "q");
    expect((await meGET(request("/api/auth/me", { origin: null, cookie: cookieOf(res)! }))).status).toBe(401);
  });

  it("answers 503 when sign-in is off", async () => {
    const { res } = await signIn();
    env.ARCOS_SESSION_SECRET = undefined;
    expect((await meGET(request("/api/auth/me", { origin: null, cookie: cookieOf(res)! }))).status).toBe(503);
  });
});

describe("POST /api/auth/logout", () => {
  it("answers 204, clears the cookie, and the old cookie stops counting", async () => {
    const { res } = await signIn();
    const cookie = cookieOf(res)!;
    const out = await logoutPOST(request("/api/auth/logout", { method: "POST", cookie }));
    expect(out.status).toBe(204);
    expect(out.headers.get("set-cookie")).toBe("arcos_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
    // A copy of the cookie kept by someone else is dead too.
    expect((await meGET(request("/api/auth/me", { origin: null, cookie }))).status).toBe(401);
    expect(await getSession(request("/api/auth/me", { cookie }), deps)).toBeNull();
  });

  it("rotates: signing in again gives a new cookie that counts, while the one from before logout does not", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const first = cookieOf((await signIn(account)).res)!;
    await logoutPOST(request("/api/auth/logout", { method: "POST", cookie: first }));
    const second = cookieOf((await signIn(account)).res)!;
    expect(second).not.toBe(first);
    expect((await meGET(request("/api/auth/me", { origin: null, cookie: second }))).status).toBe(200);
    expect((await meGET(request("/api/auth/me", { origin: null, cookie: first }))).status).toBe(401);
  });

  it("refuses another origin, or none, and signs nobody out", async () => {
    const { res } = await signIn();
    const cookie = cookieOf(res)!;
    for (const origin of ["https://evil.example", null]) {
      const out = await logoutPOST(request("/api/auth/logout", { method: "POST", cookie, origin }));
      expect(out.status).toBe(403);
    }
    expect((await meGET(request("/api/auth/me", { origin: null, cookie }))).status).toBe(200);
  });

  it("answers 401 without a session, and still clears the cookie", async () => {
    const out = await logoutPOST(request("/api/auth/logout", { method: "POST" }));
    expect(out.status).toBe(401);
    expect(out.headers.get("set-cookie")).toMatch(/^arcos_session=; /);
  });
});

describe("getSession", () => {
  it("answers the address of a signed-in wallet, and null without the secret", async () => {
    const { account, res } = await signIn();
    const req = () => request("/api/watches", { cookie: cookieOf(res)! });
    await expect(getSession(req(), deps)).resolves.toEqual({ address: account.address.toLowerCase() });
    env.ARCOS_SESSION_SECRET = undefined;
    await expect(getSession(req(), deps)).resolves.toBeNull();
  });

  it("answers null for a wallet whose user doc is gone", async () => {
    const { account, res } = await signIn();
    memory.users.delete(account.address.toLowerCase());
    await expect(getSession(request("/api/watches", { cookie: cookieOf(res)! }), deps)).resolves.toBeNull();
  });
});

describe("signatureVerifier", () => {
  it("checks an EOA signature without needing the RPC", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const message = buildSignInMessage({
      address: account.address,
      chainId: CHAIN_ID,
      nonce: "abcdefabcdefabcdefabcdefabcdefab",
      site: siteIdentity(SITE)!,
      now,
    });
    const verify = signatureVerifier(client);
    const signature = await account.signMessage({ message });
    await expect(verify({ message, signature, now })).resolves.toBe(true);
    const flipped = `${signature.slice(0, 10)}${signature[10] === "0" ? "1" : "0"}${signature.slice(11)}` as Hex;
    await expect(verify({ message, signature: flipped, now })).resolves.toBe(false);
  });
});
