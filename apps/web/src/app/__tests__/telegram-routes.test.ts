import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TTL_MS, short } from "@arcos/data";
import { BOT_USERNAME, WEBHOOK_SECRET, captureConsole, fixture, freshIp, request, signIn, type Fixture } from "./watch-fixture";

// The Telegram routes (design 5.5 and 5.6), end to end: the link a signed-in wallet asks for, the unlink, and the
// webhook Telegram calls with the bot's updates, over an in-memory store with the Firestore store's rules (the real
// store has its emulator suite in @arcos/data). Every setting comes through deps.env.

vi.mock("server-only", () => ({}));

let fx: Fixture;
vi.mock("@/lib/watch-deps", () => ({ watchDeps: () => fx.deps }));

const { POST: linkPOST, DELETE: linkDELETE } = await import("@/app/api/telegram/link/route");
const { POST: webhookPOST } = await import("@/app/api/telegram/webhook/route");

type Link = { url: string; expiresAt: string };
type Reply = { method: "sendMessage"; chat_id: number; text: string };

const LINK_UNAVAILABLE = "Telegram alerts aren't available right now.";
const LINKED = (address: string) => `Linked. Watchdog alerts for ${short(address)} will arrive in this chat. Send /stop to unlink.`;
const EXPIRED = "This link has expired or was already used. Open Watchdog on 4rcos.com and choose Link Telegram again.";
const STOPPED = "Unlinked. This chat gets no more alerts.";
const HELP = "Open Watchdog on 4rcos.com, sign in, and choose Link Telegram.";

let ip: string;
let logs: ReturnType<typeof captureConsole>;
let chats = 0;
/** A chat id no other test has used, so the per-chat limit never carries over. Telegram's ids are safe integers. */
const freshChat = () => 1_000_000_000 + (chats += 1);

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

const link = (cookie: string | null, init: Partial<Parameters<typeof request>[1]> = {}) => linkPOST(request("/api/telegram/link", { method: "POST", cookie, ip, ...init }));
const unlink = (cookie: string | null, init: Partial<Parameters<typeof request>[1]> = {}) =>
  linkDELETE(request("/api/telegram/link", { method: "DELETE", cookie, ip, ...init }));

/** The code the link's URL carries. */
const codeOf = (url: string) => new URL(url).searchParams.get("start")!;

/** A link for the wallet, through the route, and its code. */
async function linkCode(cookie: string) {
  const res = await link(cookie);
  expect(res.status).toBe(200);
  return codeOf(((await res.json()) as Link).url);
}

type WebhookInit = { secret?: string | null; contentType?: string | null; body?: string; headers?: Record<string, string> };

/** What Telegram sends: a POST with the secret header and a JSON update, from no particular client. */
const webhook = (update: unknown, init: WebhookInit = {}, post = webhookPOST) =>
  post(
    new Request("https://4rcos.com/api/telegram/webhook", {
      method: "POST",
      headers: {
        "x-real-ip": ip,
        ...(init.contentType === null ? {} : { "content-type": init.contentType ?? "application/json" }),
        ...(init.secret === null ? {} : { "x-telegram-bot-api-secret-token": init.secret ?? WEBHOOK_SECRET }),
        ...init.headers,
      },
      body: init.body ?? JSON.stringify(update),
    }),
  );

/** A private text message from a person, as Telegram's update shapes it. */
const privateMessage = (chatId: number, text: unknown, extra: Record<string, unknown> = {}) => ({
  update_id: 1,
  message: { message_id: 2, date: 1_760_000_000, chat: { id: chatId, type: "private", first_name: "A" }, from: { id: chatId, is_bot: false, first_name: "A" }, text, ...extra },
});

const bodyText = async (res: Response) => res.text();

describe("POST /api/telegram/link", () => {
  it("answers a t.me link with a fresh 22-character code and its expiry, not cached, and stores only the code's hash", async () => {
    const { address, cookie } = await signIn(fx, ip);
    const res = await link(cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Link;
    expect(Object.keys(body).sort()).toEqual(["expiresAt", "url"]);
    expect(body.url).toMatch(new RegExp(`^https://t\\.me/${BOT_USERNAME}\\?start=[A-Za-z0-9_-]{22}$`));
    expect(body.expiresAt).toBe(new Date(fx.clock.now.getTime() + TTL_MS.linkCodes).toISOString());
    const url = new URL(body.url);
    expect(url.origin).toBe("https://t.me");
    expect(url.username).toBe("");
    expect(url.password).toBe("");
    expect([...url.searchParams.keys()]).toEqual(["start"]);

    const code = codeOf(body.url);
    expect(fx.memory.codes.has(code)).toBe(false);
    expect(fx.memory.codes.get(createHash("sha256").update(code).digest("base64url"))).toEqual({ address, expiresAt: fx.clock.now.getTime() + TTL_MS.linkCodes });
    expect(codeOf(((await (await link(cookie)).json()) as Link).url)).not.toBe(code);
  });

  it("answers 503 when the bot's username isn't configured or isn't one, or sign-in isn't configured", async () => {
    const { cookie } = await signIn(fx, ip);
    for (const username of [undefined, "", "none", "arcos", "arcos watchdog bot", "0arcos_bot", "https://t.me/arcos_bot", `${"a".repeat(32)}bot`]) {
      fx.env.TELEGRAM_BOT_USERNAME = username;
      const res = await link(cookie);
      expect(res.status, String(username)).toBe(503);
      expect(await res.json()).toEqual({ error: LINK_UNAVAILABLE });
    }
    fx.env.TELEGRAM_BOT_USERNAME = "ArcosWatchdogBot";
    expect((await link(cookie)).status).toBe(200);
    fx.env.ARCOS_SESSION_SECRET = undefined;
    expect((await link(cookie)).status).toBe(503);
    expect(fx.memory.codes.size).toBe(1);
  });

  it("answers 404 on testnet, 403 for another origin or none, and 401 without a session", async () => {
    const { cookie } = await signIn(fx, ip);
    for (const origin of ["https://evil.example", null]) expect((await link(cookie, { origin })).status, String(origin)).toBe(403);
    const none = await link(null);
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ error: "Not signed in." });
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "testnet");
    const testnet = await link(cookie);
    expect(testnet.status).toBe(404);
    expect(await testnet.json()).toEqual({ error: "Not available on this network." });
    expect(fx.memory.codes.size).toBe(0);
  });

  it("answers 503 when the store fails, or can't be read for the session, and logs no detail", async () => {
    const { address, cookie } = await signIn(fx, ip);
    fx.memory.watch.createLinkCode = async () => {
      throw new Error(`linkCodes write failed for ${address}`);
    };
    const res = await link(cookie);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: LINK_UNAVAILABLE });
    fx.memory.auth.readSessionState = async () => {
      throw new Error("firestore down");
    };
    expect((await link(cookie)).status).toBe(503);
    expect(logs.text()).not.toMatch(new RegExp(`${address.slice(2)}|linkCodes|firestore`, "i"));
  });

  it("limits each client, and each wallet to 5 in 10 minutes", async () => {
    const { cookie } = await signIn(fx, ip);
    for (let i = 0; i < 5; i += 1) expect((await link(cookie)).status).toBe(200);
    const sixth = await link(cookie);
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get("retry-after")).toMatch(/^\d+$/);
    expect((await link(cookie, { ip: freshIp() })).status).toBe(429);
    let last: Response | undefined;
    for (let i = 0; i < 10; i += 1) last = await link(null);
    expect(last?.status).toBe(429);
  });
});

describe("DELETE /api/telegram/link", () => {
  it("takes the wallet's chat away and answers 200, also when it had none", async () => {
    const { address, cookie } = await signIn(fx, ip);
    const chat = freshChat();
    expect((await webhook(privateMessage(chat, `/start ${await linkCode(cookie)}`))).status).toBe(200);
    expect(fx.memory.users.get(address)?.telegram).toEqual({ chatId: chat });

    const res = await unlink(cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ telegram: "unlinked" });
    expect(fx.memory.users.get(address)?.telegram).toBeNull();
    expect((await unlink(cookie)).status).toBe(200);
  });

  it("works without the bot's username: a renamed bot must not keep a wallet linked", async () => {
    const { cookie } = await signIn(fx, ip);
    fx.env.TELEGRAM_BOT_USERNAME = "none";
    expect((await unlink(cookie)).status).toBe(200);
  });

  it("answers 403 for another origin or none, 401 without a session, 404 on testnet and 503 when the store fails", async () => {
    const { cookie } = await signIn(fx, ip);
    for (const origin of ["https://evil.example", null]) expect((await unlink(cookie, { origin })).status, String(origin)).toBe(403);
    expect((await unlink(null)).status).toBe(401);
    fx.memory.watch.unlinkWallet = async () => {
      throw new Error("down");
    };
    expect((await unlink(cookie)).status).toBe(503);
    fx.env.ARCOS_SESSION_SECRET = undefined;
    expect((await unlink(cookie)).status).toBe(503);
    fx = fixture();
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "testnet");
    expect((await unlink(null)).status).toBe(404);
  });

  it("limits each client", async () => {
    let last: Response | undefined;
    for (let i = 0; i < 11; i += 1) last = await unlink(null);
    expect(last?.status).toBe(429);
  });
});

describe("POST /api/telegram/webhook", () => {
  it("answers 503 with an empty body when the secret isn't configured, as on testnet, and never reaches the store", async () => {
    const consume = vi.spyOn(fx.memory.watch, "consumeLinkCode");
    for (const secret of [undefined, "", "none", "short-secret", "a".repeat(31), `${"a".repeat(32)}!`, "a".repeat(257)]) {
      fx.env.TELEGRAM_WEBHOOK_SECRET = secret;
      const res = await webhook(privateMessage(freshChat(), "/start xxxxxxxxxxxxxxxxxxxxxx"), { secret: secret ?? "" });
      expect(res.status, String(secret)).toBe(503);
      expect(await bodyText(res)).toBe("");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(consume).not.toHaveBeenCalled();
  });

  it("answers 401 with an empty body for a wrong or missing secret header, before the store", async () => {
    const consume = vi.spyOn(fx.memory.watch, "consumeLinkCode");
    const unlinkChat = vi.spyOn(fx.memory.watch, "unlinkChat");
    for (const secret of [null, "", `${WEBHOOK_SECRET}x`, WEBHOOK_SECRET.slice(0, -1), WEBHOOK_SECRET.toUpperCase(), `${WEBHOOK_SECRET} x`]) {
      const res = await webhook(privateMessage(freshChat(), "/stop"), { secret });
      expect(res.status, String(secret)).toBe(401);
      expect(await bodyText(res)).toBe("");
    }
    expect(consume).not.toHaveBeenCalled();
    expect(unlinkChat).not.toHaveBeenCalled();
  });

  it("answers 404 on testnet", async () => {
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "testnet");
    expect((await webhook(privateMessage(freshChat(), "/stop"))).status).toBe(404);
  });

  it("links a chat on /start with a live code, replying in the response body, and the code works once", async () => {
    const { address, cookie } = await signIn(fx, ip);
    const code = await linkCode(cookie);
    const chat = freshChat();
    const res = await webhook(privateMessage(chat, `/start ${code}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({ method: "sendMessage", chat_id: chat, text: LINKED(address) });
    expect(fx.memory.users.get(address)?.telegram).toEqual({ chatId: chat });
    expect(fx.memory.codes.size).toBe(0);

    const replay = await webhook(privateMessage(freshChat(), `/start ${code}`));
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as Reply).text).toBe(EXPIRED);
    expect(fx.memory.users.get(address)?.telegram).toEqual({ chatId: chat });
  });

  it("accepts /start@botname, and relinking replaces the chat", async () => {
    const { address, cookie } = await signIn(fx, ip);
    const first = freshChat();
    expect(((await (await webhook(privateMessage(first, `/start@${BOT_USERNAME} ${await linkCode(cookie)}`))).json()) as Reply).text).toBe(LINKED(address));
    const second = freshChat();
    expect(((await (await webhook(privateMessage(second, `/start ${await linkCode(cookie)}`))).json()) as Reply).text).toBe(LINKED(address));
    expect(fx.memory.users.get(address)?.telegram).toEqual({ chatId: second });
  });

  it("gives the one expired reply for an unknown, used or expired code, and for a /start with no code", async () => {
    const { cookie } = await signIn(fx, ip);
    const code = await linkCode(cookie);
    fx.clock.now = new Date(fx.clock.now.getTime() + TTL_MS.linkCodes);
    for (const text of [`/start ${code}`, "/start AAAAAAAAAAAAAAAAAAAAAA", "/start"]) {
      const res = await webhook(privateMessage(freshChat(), text));
      expect(res.status, text).toBe(200);
      expect(((await res.json()) as Reply).text, text).toBe(text === "/start" ? HELP : EXPIRED);
    }
    expect([...fx.memory.users.values()].every((user) => user.telegram === null)).toBe(true);
  });

  it("answers 200 with an empty body, reading nothing, to anything but a private text message from a person", async () => {
    const consume = vi.spyOn(fx.memory.watch, "consumeLinkCode");
    const unlinkChat = vi.spyOn(fx.memory.watch, "unlinkChat");
    const chat = freshChat();
    const updates: [string, unknown][] = [
      ["a group chat", { message: { chat: { id: -chat, type: "group" }, from: { is_bot: false }, text: "/stop" } }],
      ["a supergroup", { message: { chat: { id: -chat, type: "supergroup" }, from: { is_bot: false }, text: "/stop" } }],
      ["a channel post", { channel_post: { chat: { id: chat, type: "channel" }, text: "/stop" } }],
      ["a bot's message", privateMessage(chat, "/stop", { from: { id: 1, is_bot: true } })],
      ["an edited message", { edited_message: privateMessage(chat, "/stop").message }],
      ["a photo without text", privateMessage(chat, undefined, { photo: [] })],
      ["a text that isn't a string", privateMessage(chat, 42)],
      ["a chat id that isn't a safe integer", privateMessage(Number.MAX_SAFE_INTEGER + 2, "/stop")],
      ["a chat id that is a string", privateMessage("123" as unknown as number, "/stop")],
      ["a chat that isn't an object", { message: { chat: "private", text: "/stop" } }],
      ["a from that isn't an object", { message: { chat: { id: chat, type: "private" }, from: "x", text: "/stop" } }],
      ["an update without a message", { update_id: 1 }],
      ["an array", [privateMessage(chat, "/stop")]],
      ["null", null],
    ];
    for (const [name, update] of updates) {
      const res = await webhook(update);
      expect(res.status, name).toBe(200);
      expect(await bodyText(res), name).toBe("");
    }
    for (const [name, init] of [
      ["no content type", { contentType: null }],
      ["a form", { contentType: "application/x-www-form-urlencoded" }],
      ["text that isn't JSON", { body: "not json" }],
      ["a 17 KB body", { body: JSON.stringify(privateMessage(chat, "x".repeat(17 * 1024))) }],
    ] as [string, WebhookInit][]) {
      const res = await webhook(privateMessage(chat, "/stop"), init);
      expect(res.status, name).toBe(200);
      expect(await bodyText(res), name).toBe("");
    }
    expect(consume).not.toHaveBeenCalled();
    expect(unlinkChat).not.toHaveBeenCalled();
  });

  it("reads a message without a `from`, as a private message from a person", async () => {
    const chat = freshChat();
    const res = await webhook({ message: { chat: { id: chat, type: "private" }, text: "hello" } });
    expect(await res.json()).toEqual({ method: "sendMessage", chat_id: chat, text: HELP });
  });

  it("limits each chat to 10 messages a minute, then answers 200 empty with no store call", async () => {
    const unlinkChat = vi.spyOn(fx.memory.watch, "unlinkChat");
    const chat = freshChat();
    for (let i = 0; i < 10; i += 1) expect((await webhook(privateMessage(chat, "/stop"))).status).toBe(200);
    expect(unlinkChat).toHaveBeenCalledTimes(10);
    const res = await webhook(privateMessage(chat, "/stop"));
    expect(res.status).toBe(200);
    expect(await bodyText(res)).toBe("");
    expect(unlinkChat).toHaveBeenCalledTimes(10);
    // Another chat is not held back by it.
    expect(((await (await webhook(privateMessage(freshChat(), "/stop"))).json()) as Reply).text).toBe(STOPPED);
  });

  it("unlinks every wallet of the chat on /stop, and always says so", async () => {
    const a = await signIn(fx, ip);
    const b = await signIn(fx, freshIp());
    const chat = freshChat();
    expect((await webhook(privateMessage(chat, `/start ${await linkCode(a.cookie)}`))).status).toBe(200);
    expect((await webhook(privateMessage(chat, `/start ${await linkCode(b.cookie)}`))).status).toBe(200);
    const res = await webhook(privateMessage(chat, `/stop@${BOT_USERNAME}`));
    expect(await res.json()).toEqual({ method: "sendMessage", chat_id: chat, text: STOPPED });
    expect(fx.memory.users.get(a.address)?.telegram).toBeNull();
    expect(fx.memory.users.get(b.address)?.telegram).toBeNull();
    const line = logs.lines().find((l) => l.includes('"step":"stop"'));
    expect(line && JSON.parse(line)).toEqual({ severity: "INFO", message: "telegram webhook", step: "stop", count: 2 });

    const again = await webhook(privateMessage(chat, "/stop"));
    expect(((await again.json()) as Reply).text).toBe(STOPPED);
  });

  it("answers the one-line help to anything else", async () => {
    const chat = freshChat();
    for (const text of ["hello", "/help", "/start@other_bot", "/startx abc", "start xxxxxxxxxxxxxxxxxxxxxx", "/stop now", ""]) {
      const res = await webhook(privateMessage(chat, text));
      expect(res.status, text).toBe(200);
      expect(await res.json(), text).toEqual({ method: "sendMessage", chat_id: chat, text: HELP });
    }
  });

  it("answers 500 with an empty body when the store fails, so Telegram sends the update again", async () => {
    const { cookie } = await signIn(fx, ip);
    const code = await linkCode(cookie);
    fx.memory.watch.consumeLinkCode = async () => {
      throw Object.assign(new Error(`UNAVAILABLE on linkCodes/${code}`), { code: 14 });
    };
    const res = await webhook(privateMessage(freshChat(), `/start ${code}`));
    expect(res.status).toBe(500);
    expect(await bodyText(res)).toBe("");
    const line = logs.lines().find((l) => l.includes("watchdog failed"));
    expect(line && JSON.parse(line)).toEqual({ severity: "ERROR", message: "watchdog failed", step: "store", name: "Error", code: 14 });
    fx.memory.watch.unlinkChat = async () => {
      throw new Error("down");
    };
    expect((await webhook(privateMessage(freshChat(), "/stop"))).status).toBe(500);
  });

  it("limits the instance to 300 calls a minute, answering 200 empty and logging the step", async () => {
    // The limiter is one per server instance (a module-level counter keyed "telegram"), so this test runs the route over
    // a module instance of its own: the one the other tests share keeps its allowance.
    vi.resetModules();
    const { POST } = await import("@/app/api/telegram/webhook/route");
    const unlinkChat = vi.spyOn(fx.memory.watch, "unlinkChat");
    for (let i = 0; i < 300; i += 1) {
      const res = await webhook(privateMessage(freshChat(), "/stop"), {}, POST);
      expect(res.status, String(i)).toBe(200);
      expect(((await res.json()) as Reply).text).toBe(STOPPED);
    }
    expect(unlinkChat).toHaveBeenCalledTimes(300);
    for (let i = 0; i < 3; i += 1) {
      const res = await webhook(privateMessage(freshChat(), "/stop"), {}, POST);
      expect(res.status).toBe(200);
      expect(await bodyText(res)).toBe("");
    }
    expect(unlinkChat).toHaveBeenCalledTimes(300);
    const lines = logs.lines().filter((l) => l.includes('"step":"limited"'));
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!)).toEqual({ severity: "WARNING", message: "telegram webhook", step: "limited" });
  });

  it("logs no chat id, code, wallet or secret, whatever happens", async () => {
    const { address, cookie } = await signIn(fx, ip);
    const code = await linkCode(cookie);
    const chat = freshChat();
    expect((await webhook(privateMessage(chat, `/start ${code}`))).status).toBe(200);
    expect((await webhook(privateMessage(chat, "/stop"))).status).toBe(200);
    expect((await webhook(privateMessage(chat, "/stop"), { secret: "wrong" })).status).toBe(401);
    fx.memory.watch.unlinkChat = async () => {
      throw new Error(`users where telegram.chatId == ${chat} failed, code ${code}, secret ${WEBHOOK_SECRET}`);
    };
    expect((await webhook(privateMessage(chat, "/stop"))).status).toBe(500);
    const text = logs.text();
    expect(text).not.toContain(String(chat));
    expect(text).not.toContain(code);
    expect(text).not.toContain(WEBHOOK_SECRET);
    expect(text.toLowerCase()).not.toContain(address.slice(2));
    expect(text).not.toMatch(/users where|t\.me/);
    for (const line of logs.lines()) expect(() => JSON.parse(line)).not.toThrow();
  });
});
