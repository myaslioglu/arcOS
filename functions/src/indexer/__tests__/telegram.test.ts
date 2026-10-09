import { describe, expect, it } from "vitest";
import { BOT_TOKEN_FORMAT, RATE_LIMIT_PAUSE, SEND_TIMEOUT_MS, telegramSender, type SendOutcome } from "../telegram";

/** A made-up token in BotFather's shape. It must appear in nothing the sender gives back. */
const TOKEN = "1234567890:AAEabcdefghijklmnopqrstuvwxyz0123456789";
const CHAT = 987_654_321;

type Sent = { url: string; init: RequestInit };

/** A Bot API that answers every request with `answer`, or fails it with the error `answer` is. Records what was sent. */
function api(answer: Response | Error | ((n: number) => Response | Error)) {
  const sent: Sent[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), init: init ?? {} });
    const a = typeof answer === "function" ? answer(sent.length) : answer;
    if (a instanceof Error) throw a;
    return a;
  }) as typeof fetch;
  return { sent, sender: telegramSender({ token: TOKEN, fetchFn }) };
}

const reply = (status: number, body: unknown = { ok: status === 200 }) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("telegramSender", () => {
  it("posts plain text to sendMessage with no parse_mode, no link preview and a timeout, and answers ok on 200", async () => {
    const { sent, sender } = api(reply(200, { ok: true, result: { message_id: 1 } }));
    expect(await sender.send(CHAT, "DUKE (0x8f3a…913c): paused at block 1,234,567 — https://example.test/x")).toEqual({ kind: "ok" });
    expect(sent).toHaveLength(1);
    const { url, init } = sent[0]!;
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({ chat_id: CHAT, text: "DUKE (0x8f3a…913c): paused at block 1,234,567 — https://example.test/x", link_preview_options: { is_disabled: true } });
    expect(body).not.toHaveProperty("parse_mode");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(SEND_TIMEOUT_MS).toBe(4_000);
  });

  it("reads 403 as blocked and 400 'chat not found' as chat_not_found, both terminal", async () => {
    expect(await api(reply(403, { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" })).sender.send(CHAT, "x")).toEqual({ kind: "blocked" });
    expect(await api(reply(400, { ok: false, error_code: 400, description: "Bad Request: chat not found" })).sender.send(CHAT, "x")).toEqual({ kind: "chat_not_found" });
  });

  it("reads any other 400, a 200 that says ok:false, and an unexpected status as bad_request", async () => {
    expect(await api(reply(400, { ok: false, description: "Bad Request: message is too long" })).sender.send(CHAT, "x")).toEqual({ kind: "bad_request" });
    expect(await api(reply(400, "not json")).sender.send(CHAT, "x")).toEqual({ kind: "bad_request" });
    expect(await api(reply(200, { ok: false })).sender.send(CHAT, "x")).toEqual({ kind: "bad_request" });
    expect(await api(reply(302)).sender.send(CHAT, "x")).toEqual({ kind: "bad_request" });
    expect(await api(reply(418)).sender.send(CHAT, "x")).toEqual({ kind: "bad_request" });
  });

  it("reads 429 as rate_limited with the seconds asked for, bounded, and 1 s when none are", async () => {
    expect(await api(reply(429, { ok: false, parameters: { retry_after: 7 } })).sender.send(CHAT, "x")).toEqual({ kind: "rate_limited", retryAfterSec: 7 });
    expect(await api(reply(429, { ok: false, parameters: { retry_after: 2.2 } })).sender.send(CHAT, "x")).toEqual({ kind: "rate_limited", retryAfterSec: 3 });
    expect(await api(reply(429, { ok: false })).sender.send(CHAT, "x")).toEqual({ kind: "rate_limited", retryAfterSec: RATE_LIMIT_PAUSE.minSec });
    expect(await api(reply(429, { ok: false, parameters: { retry_after: 99_999 } })).sender.send(CHAT, "x")).toEqual({ kind: "rate_limited", retryAfterSec: RATE_LIMIT_PAUSE.maxSec });
    expect(await api(reply(429, { ok: false, parameters: { retry_after: -5 } })).sender.send(CHAT, "x")).toEqual({ kind: "rate_limited", retryAfterSec: RATE_LIMIT_PAUSE.minSec });
  });

  it("reads 401 and 404 as unauthorized", async () => {
    expect(await api(reply(401, { ok: false, description: "Unauthorized" })).sender.send(CHAT, "x")).toEqual({ kind: "unauthorized" });
    expect(await api(reply(404, { ok: false, description: "Not Found" })).sender.send(CHAT, "x")).toEqual({ kind: "unauthorized" });
  });

  it("reads a 5xx as telegram_5xx with its status, a timeout as timeout, and any other rejection as network", async () => {
    expect(await api(reply(502, "<html>bad gateway</html>")).sender.send(CHAT, "x")).toEqual({ kind: "telegram_5xx", status: 502 });
    expect(await api(reply(500)).sender.send(CHAT, "x")).toEqual({ kind: "telegram_5xx", status: 500 });
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    expect(await api(timeout).sender.send(CHAT, "x")).toEqual({ kind: "timeout" });
    const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(await api(aborted).sender.send(CHAT, "x")).toEqual({ kind: "timeout" });
    expect(await api(new TypeError("fetch failed")).sender.send(CHAT, "x")).toEqual({ kind: "network" });
  });

  it("never rejects, and puts the token in no outcome, whatever the API does", async () => {
    const answers: (Response | Error)[] = [
      reply(200, { ok: true }),
      reply(400, { ok: false, description: `token ${TOKEN} leaked` }),
      reply(403, { ok: false, description: TOKEN }),
      reply(401, { ok: false }),
      reply(429, { ok: false, parameters: { retry_after: 3 } }),
      reply(503, TOKEN),
      new Error(`request to https://api.telegram.org/bot${TOKEN}/sendMessage failed`),
      Object.assign(new Error(TOKEN), { name: "TimeoutError" }),
    ];
    const outcomes: SendOutcome[] = [];
    for (const answer of answers) outcomes.push(await api(answer).sender.send(CHAT, "x"));
    expect(outcomes.map((o) => o.kind)).toEqual(["ok", "bad_request", "blocked", "unauthorized", "rate_limited", "telegram_5xx", "network", "timeout"]);
    const text = JSON.stringify(outcomes);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(TOKEN.split(":")[1]);
    expect(text).not.toMatch(/https?:/);
    expect(text).not.toMatch(/description|leaked/);
  });
});

describe("BOT_TOKEN_FORMAT", () => {
  it("accepts a token in BotFather's shape and nothing else", () => {
    expect(BOT_TOKEN_FORMAT.test(TOKEN)).toBe(true);
    expect(BOT_TOKEN_FORMAT.test("123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11")).toBe(true);
    for (const bad of ["", "none", "  ", "1234567890", ":AAEabcdefghijklmnopqrstuvwxyz0123456789", "abc:AAEabcdefghijklmnopqrstuvwxyz0123456789", "1234567890:short", `${TOKEN}\n`, `bot${TOKEN}`]) {
      expect(BOT_TOKEN_FORMAT.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
