import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FREE_WATCH_LIMIT } from "@arcos/data";
import { captureConsole, fixture, freshIp, freshToken, postJson, request, signIn, timestamp, type Fixture } from "./watch-fixture";

// The watch list routes (design 5.2 to 5.4), end to end, over an in-memory store with the Firestore store's rules (the
// real store has its emulator suite in @arcos/data) and a real sign-in for the cookie. The contract check (hasCode) is
// the fixture's; every setting comes through deps.env, and the network through NEXT_PUBLIC_ARC_NETWORK.

vi.mock("server-only", () => ({}));

let fx: Fixture;
vi.mock("@/lib/watch-deps", () => ({ watchDeps: () => fx.deps }));

const { GET, POST } = await import("@/app/api/watches/route");
const { DELETE } = await import("@/app/api/watches/[token]/route");

type Answer = { limit: number; watches: { token: string; symbol: string | null; addedAt: string; latestAlert: unknown }[] };
type Failure = { error: string };

let ip: string;
let logs: ReturnType<typeof captureConsole>;

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
  fx = fixture();
  ip = freshIp();
  logs = captureConsole();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const list = (cookie: string | null, init: Partial<Parameters<typeof request>[1]> = {}) => GET(request("/api/watches", { origin: null, cookie, ip, ...init }));
const add = (cookie: string | null, body: unknown, init: Partial<Parameters<typeof postJson>[2]> = {}) => POST(postJson("/api/watches", body, { cookie, ip, ...init }));
const remove = (cookie: string | null, token: string, init: Partial<Parameters<typeof request>[1]> = {}) =>
  DELETE(request(`/api/watches/${token}`, { method: "DELETE", cookie, ip, ...init }), { params: Promise.resolve({ token }) });

describe("GET /api/watches", () => {
  it("answers the wallet's list, newest first, with dates as ISO strings and the latest alert, not cached", async () => {
    const { address, cookie } = await signIn(fx, ip);
    const empty = await list(cookie);
    expect(empty.status).toBe(200);
    expect(empty.headers.get("cache-control")).toBe("no-store");
    expect(await empty.json()).toEqual({ limit: FREE_WATCH_LIMIT, watches: [] });

    const first = freshToken();
    const second = freshToken();
    expect((await add(cookie, { token: first })).status).toBe(201);
    fx.clock.now = new Date(fx.clock.now.getTime() + 60_000);
    expect((await add(cookie, { token: second })).status).toBe(201);
    fx.memory.symbols.set(second, "DUKE");
    fx.memory.alerts.set(first, { kind: "paused", block: 1_234_567, at: timestamp(fx.clock.now), text: "paused", link: "https://explorer.arc.io/token/x" });

    const res = await list(cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      limit: FREE_WATCH_LIMIT,
      watches: [
        { token: second, symbol: "DUKE", addedAt: fx.clock.now.toISOString(), latestAlert: null },
        {
          token: first,
          symbol: null,
          addedAt: "2026-10-09T12:00:00.000Z",
          latestAlert: { kind: "paused", block: 1_234_567, at: fx.clock.now.toISOString(), text: "paused", link: "https://explorer.arc.io/token/x" },
        },
      ],
    });
    // The wallet only ever comes from the session: nothing in the answer names it, and no watcher count leaves.
    expect(JSON.stringify(await (await list(cookie)).json())).not.toContain(address.slice(2));
    expect(JSON.stringify(await (await list(cookie)).json())).not.toMatch(/watchers|user/);
  });

  it("answers 401 without a session, and 403 for an Origin that is another site's", async () => {
    expect((await list(null)).status).toBe(401);
    expect(((await (await list(null)).json()) as Failure).error).toBe("Not signed in.");
    expect((await list(null, { cookie: "__Host-arcos_session=a.b.c" })).status).toBe(401);
    const { cookie } = await signIn(fx, ip);
    expect((await list(cookie, { origin: "https://evil.example" })).status).toBe(403);
    expect((await list(cookie, { origin: "https://4rcos.com" })).status).toBe(200);
  });

  it("answers 503 when sign-in isn't configured, and 404 off mainnet or where the index isn't read", async () => {
    const { cookie } = await signIn(fx, ip);
    for (const secret of [undefined, "", "too-short"]) {
      fx.env.ARCOS_SESSION_SECRET = secret;
      const res = await list(cookie);
      expect(res.status, String(secret)).toBe(503);
      expect(((await res.json()) as Failure).error).toBe("Watchdog isn't available right now.");
    }
    fx.env.ARCOS_SESSION_SECRET = undefined;
    fx.env.NEXT_PUBLIC_SITE_URL = undefined;
    expect((await list(cookie)).status).toBe(503);

    fx = fixture();
    const signed = await signIn(fx, ip);
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "testnet");
    const testnet = await list(signed.cookie);
    expect(testnet.status).toBe(404);
    expect(await testnet.json()).toEqual({ error: "Not available on this network." });
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
    fx.env.K_SERVICE = undefined;
    expect((await list(signed.cookie)).status).toBe(404);
  });

  it("answers 503, not 401, when the store can't be read, and logs no detail", async () => {
    const { address, cookie } = await signIn(fx, ip);
    fx.memory.auth.readSessionState = async () => {
      throw new Error(`firestore said something about users/${address}`);
    };
    const res = await list(cookie);
    expect(res.status).toBe(503);
    expect(logs.text()).not.toMatch(new RegExp(`${address.slice(2)}|firestore said`, "i"));

    fx = fixture();
    const signed = await signIn(fx, ip);
    fx.memory.watch.listWatches = async () => {
      throw new Error("down");
    };
    expect((await list(signed.cookie)).status).toBe(503);
  });

  it("limits each client", async () => {
    const { cookie } = await signIn(fx, ip);
    let last: Response | undefined;
    for (let i = 0; i < 61; i += 1) last = await list(cookie);
    expect(last?.status).toBe(429);
    expect(last?.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(((await last!.json()) as Failure).error).toBe("Too many requests. Try again in a minute.");
  });
});

describe("POST /api/watches", () => {
  it("adds a token: 201 with the list, then 200 when it is already watched, and the store holds the lowercase token", async () => {
    const { address, cookie } = await signIn(fx, ip);
    const token = freshToken();
    const mixed = `0x${token.slice(2, 22).toUpperCase()}${token.slice(22)}`;
    const added = await add(cookie, { token: mixed });
    expect(added.status).toBe(201);
    expect(added.headers.get("cache-control")).toBe("no-store");
    const body = (await added.json()) as Answer;
    expect(body.limit).toBe(FREE_WATCH_LIMIT);
    expect(body.watches.map((w) => w.token)).toEqual([token]);
    expect([...fx.memory.watches.values()]).toEqual([{ user: address, network: "mainnet", token, createdAt: fx.clock.now }]);
    expect(fx.memory.users.get(address)?.watchCount).toBe(1);

    const again = await add(cookie, { token });
    expect(again.status).toBe(200);
    expect(((await again.json()) as Answer).watches).toHaveLength(1);
  });

  it("refuses the 4th token with 409 and the limit sentence", async () => {
    const { cookie } = await signIn(fx, ip);
    for (let i = 0; i < FREE_WATCH_LIMIT; i += 1) expect((await add(cookie, { token: freshToken() })).status).toBe(201);
    const res = await add(cookie, { token: freshToken() });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "You can watch up to 3 tokens. Remove one to add another." });
    expect(fx.memory.watches.size).toBe(FREE_WATCH_LIMIT);
  });

  it("refuses a request from another origin, or with none, before reading it", async () => {
    const { cookie } = await signIn(fx, ip);
    for (const origin of ["https://evil.example", "https://4rcos.com.evil.example", "http://4rcos.com", "null", null]) {
      const res = await add(cookie, { token: freshToken() }, { origin });
      expect(res.status, String(origin)).toBe(403);
      expect(await res.json()).toEqual({ error: "This request didn't come from this site." });
    }
    expect(fx.memory.watches.size).toBe(0);
  });

  it("refuses a body that isn't JSON, is too long, or isn't { token }, and a token that isn't an address", async () => {
    const { cookie } = await signIn(fx, ip);
    const form = await add(cookie, "token=x", { contentType: "application/x-www-form-urlencoded" });
    expect(form.status).toBe(415);
    const huge = await add(cookie, { token: "x".repeat(2_000) });
    expect(huge.status).toBe(413);
    for (const body of ["not json", "[]", "{}", { token: 1 }, { token: null }]) {
      const res = await add(cookie, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({ error: "The request isn't valid." });
    }
    for (const token of ["", "0x", "0x1234", `0x${"g".repeat(40)}`, "duke.eth", `${freshToken()} `]) {
      const res = await add(cookie, { token });
      expect(res.status, token).toBe(400);
      expect(await res.json()).toEqual({ error: "That isn't an address." });
    }
    expect(fx.memory.watches.size).toBe(0);
  });

  it("answers 401 without a session, and 401 for a wallet the store has no user doc for", async () => {
    const res = await add(null, { token: freshToken() });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Not signed in." });

    const { cookie } = await signIn(fx, ip);
    fx.memory.watch.addWatch = async () => ({ kind: "no-user" });
    expect((await add(cookie, { token: freshToken() })).status).toBe(401);
  });

  it("refuses an address with no contract, and answers 503 when Arc can't be reached, before the store", async () => {
    const { cookie } = await signIn(fx, ip);
    const addWatch = vi.spyOn(fx.memory.watch, "addWatch");
    fx.code.answer = false;
    const none = await add(cookie, { token: freshToken() });
    expect(none.status).toBe(400);
    expect(await none.json()).toEqual({ error: "No contract at that address." });

    fx.code.answer = new Error("rpc down at https://rpc.arc.io");
    const down = await add(cookie, { token: freshToken() });
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ error: "Couldn't reach Arc. Try again in a minute." });
    expect(addWatch).not.toHaveBeenCalled();
    expect(logs.text()).not.toContain("rpc.arc.io");
  });

  it("checks the contract only for a signed-in wallet", async () => {
    const hasCode = vi.spyOn(fx.deps, "hasCode");
    expect((await add(null, { token: freshToken() })).status).toBe(401);
    expect(hasCode).not.toHaveBeenCalled();
  });

  it("answers 503 when the store fails, and logs the step without the token or the wallet", async () => {
    const { address, cookie } = await signIn(fx, ip);
    const token = freshToken();
    fx.memory.watch.addWatch = async () => {
      throw Object.assign(new Error(`PERMISSION_DENIED on watches/${address}:mainnet:${token}`), { code: 7 });
    };
    const res = await add(cookie, { token });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Watchdog isn't available right now." });
    const line = logs.lines().find((l) => l.includes("watchdog failed"));
    expect(line && JSON.parse(line)).toEqual({ severity: "ERROR", message: "watchdog failed", step: "add", name: "Error", code: 7 });
    expect(logs.text()).not.toMatch(new RegExp(`${address.slice(2)}|${token.slice(2)}|PERMISSION`, "i"));
  });

  it("answers 503 when sign-in isn't configured, before the Origin, and 404 on testnet", async () => {
    fx.env.ARCOS_SESSION_SECRET = undefined;
    const res = await add(null, { token: freshToken() }, { origin: null });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Watchdog isn't available right now." });

    fx = fixture();
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "testnet");
    const testnet = await add(null, { token: freshToken() });
    expect(testnet.status).toBe(404);
    expect(await testnet.json()).toEqual({ error: "Not available on this network." });
  });

  it("limits each client, and each wallet", async () => {
    const { cookie } = await signIn(fx, ip);
    let last: Response | undefined;
    for (let i = 0; i < 11; i += 1) last = await add(cookie, { token: freshToken() });
    expect(last?.status).toBe(429);
    expect(last?.headers.get("retry-after")).toMatch(/^\d+$/);
    // The same wallet from another client is still over its own limit; a client over its limit is refused earlier.
    expect((await add(cookie, { token: freshToken() }, { ip: freshIp() })).status).toBe(429);
    for (let i = 0; i < 10; i += 1) last = await add(null, {});
    expect(last?.status).toBe(429);
  });
});

describe("DELETE /api/watches/[token]", () => {
  it("removes the token and answers 200 with the list, and 200 with the list for a token that wasn't watched", async () => {
    const { address, cookie } = await signIn(fx, ip);
    const token = freshToken();
    const other = freshToken();
    expect((await add(cookie, { token })).status).toBe(201);
    expect((await add(cookie, { token: other })).status).toBe(201);

    const res = await remove(cookie, `0x${token.slice(2).toUpperCase()}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(((await res.json()) as Answer).watches.map((w) => w.token)).toEqual([other]);
    expect(fx.memory.users.get(address)?.watchCount).toBe(1);

    const absent = await remove(cookie, token);
    expect(absent.status).toBe(200);
    expect(((await absent.json()) as Answer).watches.map((w) => w.token)).toEqual([other]);
  });

  it("lets another wallet neither see nor remove a watch", async () => {
    const owner = await signIn(fx, ip);
    const other = await signIn(fx, freshIp());
    const token = freshToken();
    expect((await add(owner.cookie, { token })).status).toBe(201);

    expect(await (await list(other.cookie)).json()).toEqual({ limit: FREE_WATCH_LIMIT, watches: [] });
    const res = await remove(other.cookie, token);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Answer).watches).toEqual([]);
    expect(((await (await list(owner.cookie)).json()) as Answer).watches.map((w) => w.token)).toEqual([token]);
  });

  it("refuses a path that isn't an address, another origin or none, and no session", async () => {
    const { cookie } = await signIn(fx, ip);
    const token = freshToken();
    expect((await add(cookie, { token })).status).toBe(201);
    for (const path of ["duke", "0x1234", `${token}x`, "../tokens"]) {
      const res = await remove(cookie, path);
      expect(res.status, path).toBe(400);
      expect(await res.json()).toEqual({ error: "That isn't an address." });
    }
    for (const origin of ["https://evil.example", null]) expect((await remove(cookie, token, { origin })).status, String(origin)).toBe(403);
    expect((await remove(null, token)).status).toBe(401);
    expect(fx.memory.watches.size).toBe(1);
  });

  it("answers 503 when sign-in isn't configured or the store fails, and 404 on testnet", async () => {
    const { cookie } = await signIn(fx, ip);
    const token = freshToken();
    fx.memory.watch.removeWatch = async () => {
      throw new Error("down");
    };
    expect((await remove(cookie, token)).status).toBe(503);
    fx.env.ARCOS_SESSION_SECRET = undefined;
    expect((await remove(cookie, token)).status).toBe(503);
    fx = fixture();
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "testnet");
    expect((await remove(null, token)).status).toBe(404);
  });

  it("limits each client, and each wallet", async () => {
    const { cookie } = await signIn(fx, ip);
    const token = freshToken();
    let last: Response | undefined;
    for (let i = 0; i < 11; i += 1) last = await remove(cookie, token);
    expect(last?.status).toBe(429);
    for (let i = 0; i < 10; i += 1) last = await remove(null, token);
    expect(last?.status).toBe(429);
  });
});

describe("the logs", () => {
  it("hold no wallet, token or error message, whatever fails", async () => {
    const { address, cookie } = await signIn(fx, ip);
    const token = freshToken();
    const boom = (what: string) => async () => {
      throw new Error(`${what} failed for ${address} on ${token}`);
    };
    fx.memory.watch.addWatch = boom("add");
    fx.memory.watch.removeWatch = boom("remove");
    fx.memory.watch.listWatches = boom("list");
    fx.code.answer = new Error(`getCode ${token}`);
    expect((await add(cookie, { token })).status).toBe(503);
    fx.code.answer = true;
    expect((await add(cookie, { token })).status).toBe(503);
    expect((await remove(cookie, token)).status).toBe(503);
    expect((await list(cookie)).status).toBe(503);
    const text = logs.text();
    expect(text).toMatch(/"step":"code"/);
    expect(text).toMatch(/"step":"add"/);
    expect(text).toMatch(/"step":"remove"/);
    expect(text).toMatch(/"step":"list"/);
    expect(text.toLowerCase()).not.toContain(address.slice(2));
    expect(text.toLowerCase()).not.toContain(token.slice(2));
    expect(text).not.toMatch(/failed for|getCode/);
    for (const line of logs.lines()) expect(() => JSON.parse(line)).not.toThrow();
  });
});
