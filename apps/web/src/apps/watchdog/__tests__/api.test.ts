import { describe, expect, it, vi } from "vitest";
import type { WatchesAnswer } from "@/lib/watch-server";
import {
  TELEGRAM_UNAVAILABLE,
  UNAVAILABLE,
  WatchFetchError,
  addWatch,
  fetchWatches,
  linkTelegram,
  parseWatchesAnswer,
  removeWatch,
  telegramLinkUrl,
  unlinkTelegram,
  watchesQueryOptions,
} from "../api";

// The window's fetches over a stubbed fetch: what each route's answer becomes, and which sentence a failure shows.
// Nothing here reaches the network; every address is a test fixture.

const TOKEN = "0x470f09ae20163d5e243f6530fb328912a8fcb099";
const OTHER = "0x2222222222222222222222222222222222222222";
const LINK = `https://explorer.example/token/${TOKEN}`;
const answer: WatchesAnswer = {
  limit: 3,
  watches: [
    {
      token: "0x470F09AE20163D5E243F6530FB328912A8FCB099",
      symbol: "WDG",
      addedAt: "2026-10-09T12:00:00.000Z",
      latestAlert: { kind: "paused", block: 1_234_567, at: "2026-10-09T12:05:00.000Z", text: "WDG (0x470f…b099): paused at block 1,234,567", link: LINK },
    },
    { token: OTHER, symbol: null, addedAt: "2026-10-09T11:00:00.000Z", latestAlert: null },
  ],
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const text = (status: number, body: string): Response => new Response(body, { status });

type Call = { input: string; init: RequestInit | undefined };
/** A fetch that answers `responses` in turn and records what it was asked. */
function stub(...responses: Array<Response | Error>): { request: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const request = vi.fn(async (input: string | URL | globalThis.Request, init?: RequestInit) => {
    calls.push({ input: String(input), init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next ?? text(500, "");
  }) as unknown as typeof fetch;
  return { request, calls };
}

describe("parseWatchesAnswer", () => {
  it("reads the list, lowercases each token and keeps the newest alert's sentence and link", () => {
    expect(parseWatchesAnswer(answer)).toEqual({
      limit: 3,
      watches: [
        { token: TOKEN, symbol: "WDG", addedAt: "2026-10-09T12:00:00.000Z", latestAlert: { text: "WDG (0x470f…b099): paused at block 1,234,567", link: LINK } },
        { token: OTHER, symbol: null, addedAt: "2026-10-09T11:00:00.000Z", latestAlert: null },
      ],
    });
  });

  it("drops a row whose token isn't an address, and a repeat of an earlier token", () => {
    const list = parseWatchesAnswer({
      limit: 3,
      watches: [
        { token: "0x12", symbol: "X", addedAt: "", latestAlert: null },
        { token: TOKEN, symbol: "A", addedAt: "", latestAlert: null },
        { token: TOKEN.toUpperCase().replace("0X", "0x"), symbol: "B", addedAt: "", latestAlert: null },
        "not a row",
        null,
      ],
    });
    expect(list.watches.map((w) => w.symbol)).toEqual(["A"]);
  });

  it("cleans a symbol again, and keeps an alert's link only when it is https", () => {
    const list = parseWatchesAnswer({
      limit: 3,
      watches: [
        { token: TOKEN, symbol: " ‮WDG\n ", addedAt: "", latestAlert: { text: "changed", link: "javascript:alert(1)" } },
        { token: OTHER, symbol: "", addedAt: "", latestAlert: { text: "", link: LINK } },
      ],
    });
    expect(list.watches[0]).toMatchObject({ symbol: "WDG", latestAlert: { text: "changed", link: null } });
    expect(list.watches[1]).toMatchObject({ symbol: null, latestAlert: null });
  });

  it("reads a limit that isn't a small whole number as 0", () => {
    for (const limit of [undefined, "3", -1, 1.5, 101, null]) {
      expect(parseWatchesAnswer({ limit, watches: [] }).limit, String(limit)).toBe(0);
    }
    expect(parseWatchesAnswer({ limit: 3, watches: [] }).limit).toBe(3);
  });

  it("throws on anything but a list", () => {
    for (const body of [null, "x", [], {}, { watches: "none" }, { limit: 3 }]) {
      expect(() => parseWatchesAnswer(body), JSON.stringify(body)).toThrow(WatchFetchError);
    }
  });
});

describe("fetchWatches", () => {
  it("asks GET /api/watches with the session cookie and answers the list", async () => {
    const { request, calls } = stub(json(200, answer));
    const list = await fetchWatches(request);
    expect(list.watches).toHaveLength(2);
    expect(calls[0]?.input).toBe("/api/watches");
    expect(calls[0]?.init?.credentials).toBe("same-origin");
    expect(calls[0]?.init?.method).toBeUndefined();
  });

  it("throws the status on an error answer, and null when there was no answer or no list", async () => {
    await expect(fetchWatches(stub(json(503, { error: "down" })).request)).rejects.toMatchObject({ name: "WatchFetchError", status: 503 });
    await expect(fetchWatches(stub(json(401, { error: "Not signed in." })).request)).rejects.toMatchObject({ status: 401 });
    await expect(fetchWatches(stub(new TypeError("offline")).request)).rejects.toMatchObject({ status: null });
    await expect(fetchWatches(stub(text(200, "<html>")).request)).rejects.toMatchObject({ status: null });
    await expect(fetchWatches(stub(json(200, { rows: [] })).request)).rejects.toMatchObject({ status: null });
  });
});

describe("addWatch", () => {
  it("POSTs the token as JSON with the session cookie, and tells an add (201) from an existing watch (200)", async () => {
    const { request, calls } = stub(json(201, answer), json(200, answer));
    expect(await addWatch(TOKEN, request)).toMatchObject({ ok: true, added: true });
    expect(await addWatch(TOKEN, request)).toMatchObject({ ok: true, added: false });
    const [first] = calls;
    expect(first?.input).toBe("/api/watches");
    expect(first?.init).toMatchObject({ method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" } });
    expect(JSON.parse(first?.init?.body as string)).toEqual({ token: TOKEN });
  });

  it("shows the route's own sentence as given, cut at 200 characters, with the status", async () => {
    const limit = "You can watch up to 3 tokens. Remove one to add another.";
    expect(await addWatch(TOKEN, stub(json(409, { error: limit })).request)).toEqual({ ok: false, error: limit, status: 409 });
    expect(await addWatch(TOKEN, stub(json(400, { error: "No contract at that address." })).request)).toEqual({ ok: false, error: "No contract at that address.", status: 400 });
    expect(await addWatch(TOKEN, stub(json(401, { error: "Not signed in." })).request)).toEqual({ ok: false, error: "Not signed in.", status: 401 });
    const long = await addWatch(TOKEN, stub(json(503, { error: "x".repeat(250) })).request);
    expect(long).toEqual({ ok: false, error: "x".repeat(200), status: 503 });
  });

  it("shows the one fallback when the route gave no sentence, no answer, or not a list, and the status the route answered, or null without one", async () => {
    expect(await addWatch(TOKEN, stub(text(500, "boom")).request)).toEqual({ ok: false, error: UNAVAILABLE, status: 500 });
    expect(await addWatch(TOKEN, stub(json(503, { error: "" })).request)).toEqual({ ok: false, error: UNAVAILABLE, status: 503 });
    expect(await addWatch(TOKEN, stub(json(429, { message: "slow down" })).request)).toEqual({ ok: false, error: UNAVAILABLE, status: 429 });
    expect(await addWatch(TOKEN, stub(new TypeError("offline")).request)).toEqual({ ok: false, error: UNAVAILABLE, status: null });
    expect(await addWatch(TOKEN, stub(json(201, { nope: 1 })).request)).toEqual({ ok: false, error: UNAVAILABLE, status: null });
  });
});

describe("removeWatch", () => {
  it("DELETEs /api/watches/[token] with the session cookie and answers the list", async () => {
    const { request, calls } = stub(json(200, { limit: 3, watches: [] }));
    expect(await removeWatch(TOKEN, request)).toEqual({ ok: true, added: false, list: { limit: 3, watches: [] } });
    expect(calls[0]?.input).toBe(`/api/watches/${TOKEN}`);
    expect(calls[0]?.init).toMatchObject({ method: "DELETE", credentials: "same-origin" });
  });

  it("shows the route's sentence, or the fallback", async () => {
    expect(await removeWatch(TOKEN, stub(json(400, { error: "That isn't an address." })).request)).toEqual({ ok: false, error: "That isn't an address.", status: 400 });
    expect(await removeWatch(TOKEN, stub(new TypeError("offline")).request)).toEqual({ ok: false, error: UNAVAILABLE, status: null });
  });
});

describe("telegramLinkUrl", () => {
  it("takes an https link on t.me itself", () => {
    expect(telegramLinkUrl("https://t.me/arcos_watchdog_bot?start=AbCdEfGhIjKlMnOpQrStUv")).toBe("https://t.me/arcos_watchdog_bot?start=AbCdEfGhIjKlMnOpQrStUv");
  });

  it("refuses any other origin, a username or password in front of the host, and anything that isn't a URL", () => {
    for (const value of [
      "http://t.me/bot?start=x",
      "https://evil.example/t.me",
      "https://t.me.evil.example/bot",
      "https://evil.t.me/bot",
      "https://t.me:8443/bot",
      "https://t.me@evil.example/bot",
      "https://user:pw@t.me/bot",
      "https://user@t.me/bot",
      "javascript:alert(1)",
      "t.me/bot",
      "",
      null,
      undefined,
      42,
      { href: "https://t.me/bot" },
    ]) {
      expect(telegramLinkUrl(value), String(value)).toBeNull();
    }
  });
});

describe("linkTelegram", () => {
  it("POSTs /api/telegram/link with the session cookie and answers the checked link", async () => {
    const url = "https://t.me/arcos_watchdog_bot?start=AbCdEfGhIjKlMnOpQrStUv";
    const { request, calls } = stub(json(200, { url, expiresAt: "2026-10-09T12:10:00.000Z" }));
    expect(await linkTelegram(request)).toEqual({ ok: true, url });
    expect(calls[0]?.input).toBe("/api/telegram/link");
    expect(calls[0]?.init).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(calls[0]?.init?.body).toBeUndefined();
  });

  it("never answers a link that isn't on t.me", async () => {
    expect(await linkTelegram(stub(json(200, { url: "https://evil.example/start" })).request)).toEqual({ ok: false, error: TELEGRAM_UNAVAILABLE, status: null });
    expect(await linkTelegram(stub(json(200, { url: "https://t.me@evil.example/start" })).request)).toEqual({ ok: false, error: TELEGRAM_UNAVAILABLE, status: null });
    expect(await linkTelegram(stub(json(200, {})).request)).toEqual({ ok: false, error: TELEGRAM_UNAVAILABLE, status: null });
  });

  it("shows the route's sentence, or the fallback", async () => {
    expect(await linkTelegram(stub(json(503, { error: "Telegram alerts aren't available right now." })).request)).toEqual({ ok: false, error: "Telegram alerts aren't available right now.", status: 503 });
    expect(await linkTelegram(stub(json(429, { error: "Too many requests. Try again in 30 seconds." })).request)).toEqual({ ok: false, error: "Too many requests. Try again in 30 seconds.", status: 429 });
    expect(await linkTelegram(stub(new TypeError("offline")).request)).toEqual({ ok: false, error: TELEGRAM_UNAVAILABLE, status: null });
    expect(await linkTelegram(stub(text(502, "bad gateway")).request)).toEqual({ ok: false, error: TELEGRAM_UNAVAILABLE, status: 502 });
  });
});

describe("unlinkTelegram", () => {
  it("DELETEs /api/telegram/link with the session cookie", async () => {
    const { request, calls } = stub(json(200, { telegram: "unlinked" }));
    expect(await unlinkTelegram(request)).toEqual({ ok: true });
    expect(calls[0]?.input).toBe("/api/telegram/link");
    expect(calls[0]?.init).toMatchObject({ method: "DELETE", credentials: "same-origin" });
  });

  it("shows the route's sentence, or the fallback", async () => {
    expect(await unlinkTelegram(stub(json(401, { error: "Not signed in." })).request)).toEqual({ ok: false, error: "Not signed in.", status: 401 });
    expect(await unlinkTelegram(stub(new TypeError("offline")).request)).toEqual({ ok: false, error: TELEGRAM_UNAVAILABLE, status: null });
  });
});

describe("watchesQueryOptions", () => {
  it("polls every 60 s, not in the background, refetches on focus, and never retries", () => {
    const options = watchesQueryOptions();
    expect(options.queryKey).toEqual(["watches"]);
    expect(options.refetchInterval).toBe(60_000);
    expect(options.refetchIntervalInBackground).toBe(false);
    expect(options.refetchOnWindowFocus).toBe(true);
    expect(options.retry).toBe(false);
  });
});
