import { queryOptions } from "@tanstack/react-query";
import { cleanLabel } from "@arcos/inspector";

// The window's side of the Watchdog routes (design 5): GET /api/watches as a query the window polls, and the four
// changes (watch, remove, link Telegram, unlink) as plain fetches that answer a result the window shows. Every answer
// crossed the network, so it is checked field by field, and a route's own error sentence is shown as given, at most
// 200 characters; anything else gets one sentence. The shapes checked here are lib/watch-server.ts's WatchesAnswer and
// WatchRow. Nothing here imports @arcos/data or the routes' server code, so the client bundle stays free of both.

/** What a request is made with: `fetch` in the app, a stub in tests. */
export type Request = typeof fetch;

export const UNAVAILABLE = "Watchdog isn't available right now. Try again in a minute.";
export const TELEGRAM_UNAVAILABLE = "Telegram alerts aren't available right now.";
/** The most of a route's error sentence that is shown. */
const SENTENCE_MAX = 200;
/** Every request gives up after this long. */
const TIMEOUT_MS = 10_000;

/** One watched token as the window shows it: the row GET /api/watches answers (WatchRow), with its address lowercased. */
export type WatchItem = {
  token: string;
  symbol: string | null;
  addedAt: string;
  /** The newest alert's sentence and explorer link (null when the link isn't https), or null before any change was seen. */
  latestAlert: { text: string; link: string | null } | null;
};

/** The list, with the free limit the route states. */
export type WatchList = { limit: number; watches: WatchItem[] };

/** The route answered an error status (`status`), or didn't answer at all or answered something else (null). */
export class WatchFetchError extends Error {
  constructor(readonly status: number | null) {
    super("watch fetch failed");
    this.name = "WatchFetchError";
  }
}

/**
 * A request that failed: the sentence to show, and the status the route answered (null when it didn't answer, or
 * answered something that isn't an answer). A 401 tells the window the session is gone, so it can ask the gate.
 */
export type Refusal = { ok: false; error: string; status: number | null };

/** A change's outcome: the list as the route answered it after the change, or the refusal to show. */
export type ChangeResult = { ok: true; added: boolean; list: WatchList } | Refusal;

export type LinkResult = { ok: true; url: string } | Refusal;
export type UnlinkResult = { ok: true } | Refusal;

const refused = (error: string, status: number | null): Refusal => ({ ok: false, error, status });

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** Three watches today; a limit of up to 100 is believed, so a wrong answer can't draw an endless footer. */
const MAX_LIMIT = 100;
/** At most this many characters of an alert's sentence, which the function writes under 300. */
const ALERT_TEXT_MAX = 400;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parseAlert(raw: unknown): WatchItem["latestAlert"] {
  if (!isRecord(raw) || typeof raw.text !== "string" || raw.text.length === 0) return null;
  const link = typeof raw.link === "string" && /^https:\/\//.test(raw.link) ? raw.link : null;
  return { text: [...raw.text].slice(0, ALERT_TEXT_MAX).join(""), link };
}

/**
 * The route's answer, checked field by field: a row whose token isn't an address, or whose address a row before it
 * has, is dropped; a symbol is cleaned again; an alert without a sentence reads as none. Anything but an answer throws.
 */
export function parseWatchesAnswer(json: unknown): WatchList {
  if (!isRecord(json) || !Array.isArray(json.watches)) throw new WatchFetchError(null);
  const limit = typeof json.limit === "number" && Number.isInteger(json.limit) && json.limit >= 0 && json.limit <= MAX_LIMIT ? json.limit : 0;
  const watches: WatchItem[] = [];
  const seen = new Set<string>();
  for (const raw of json.watches as unknown[]) {
    if (!isRecord(raw)) continue;
    if (typeof raw.token !== "string" || !ADDRESS.test(raw.token)) continue;
    const token = raw.token.toLowerCase();
    if (seen.has(token)) continue;
    seen.add(token);
    watches.push({
      token,
      symbol: typeof raw.symbol === "string" ? cleanLabel(raw.symbol, 32) : null,
      addedAt: typeof raw.addedAt === "string" ? raw.addedAt : "",
      latestAlert: parseAlert(raw.latestAlert),
    });
  }
  return { limit, watches };
}

/** The route's own error sentence from a JSON answer, cut at 200 characters, or null when it gave none. */
async function serverSentence(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === "string" && body.error.length > 0 ? [...body.error].slice(0, SENTENCE_MAX).join("") : null;
  } catch {
    return null;
  }
}

/** The watch list, at most 10 s; an error status, no answer, or a body that isn't a list throws WatchFetchError. */
export async function fetchWatches(request: Request = fetch): Promise<WatchList> {
  let res: Response;
  try {
    res = await request("/api/watches", { credentials: "same-origin", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new WatchFetchError(null);
  }
  if (!res.ok) throw new WatchFetchError(res.status);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new WatchFetchError(null);
  }
  return parseWatchesAnswer(json);
}

/** A change that answers the list: the list when it did, else the route's sentence or the one fallback. Never throws. */
async function change(request: Request, input: string, init: RequestInit, fallback: string): Promise<ChangeResult> {
  let res: Response;
  try {
    res = await request(input, { ...init, credentials: "same-origin", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return refused(fallback, null);
  }
  if (!res.ok) return refused((await serverSentence(res)) ?? fallback, res.status);
  try {
    return { ok: true, added: res.status === 201, list: parseWatchesAnswer(await res.json()) };
  } catch {
    return refused(fallback, null);
  }
}

/** POST /api/watches: watches the token. `added` is false when the wallet already watched it (the route's 200). */
export function addWatch(token: string, request: Request = fetch): Promise<ChangeResult> {
  return change(request, "/api/watches", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) }, UNAVAILABLE);
}

/** DELETE /api/watches/[token]: stops watching the token. The route answers the list whether or not it was watched. */
export function removeWatch(token: string, request: Request = fetch): Promise<ChangeResult> {
  return change(request, `/api/watches/${encodeURIComponent(token)}`, { method: "DELETE" }, UNAVAILABLE);
}

/**
 * The link a route answered, when it is one the window may open: an https URL whose origin is exactly https://t.me,
 * with no username or password smuggled in front of the host. Anything else is null and is never opened.
 */
export function telegramLinkUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.origin !== "https://t.me" || url.username !== "" || url.password !== "") return null;
  return url.href;
}

/** POST /api/telegram/link: a fresh t.me link to the bot's chat, checked by telegramLinkUrl. Never throws. */
export async function linkTelegram(request: Request = fetch): Promise<LinkResult> {
  let res: Response;
  try {
    res = await request("/api/telegram/link", { method: "POST", credentials: "same-origin", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return refused(TELEGRAM_UNAVAILABLE, null);
  }
  if (!res.ok) return refused((await serverSentence(res)) ?? TELEGRAM_UNAVAILABLE, res.status);
  let url: string | null;
  try {
    const body = (await res.json()) as { url?: unknown };
    url = telegramLinkUrl(body.url);
  } catch {
    url = null;
  }
  return url ? { ok: true, url } : refused(TELEGRAM_UNAVAILABLE, null);
}

/** DELETE /api/telegram/link: takes the wallet's chat away. Never throws. */
export async function unlinkTelegram(request: Request = fetch): Promise<UnlinkResult> {
  let res: Response;
  try {
    res = await request("/api/telegram/link", { method: "DELETE", credentials: "same-origin", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return refused(TELEGRAM_UNAVAILABLE, null);
  }
  if (!res.ok) return refused((await serverSentence(res)) ?? TELEGRAM_UNAVAILABLE, res.status);
  return { ok: true };
}


/** The query's key: what the window reads the list under, and what a change writes the route's answer to. */
export const WATCHES_KEY = ["watches"] as const;

/**
 * The list's query: asked on mount, then every 60 s and whenever the window regains focus (an alert may have arrived),
 * never while the tab is hidden. A failed refresh keeps the last list on screen. Changes don't go through it: they
 * write the list the route answered (see the window).
 */
export const watchesQueryOptions = () =>
  queryOptions({
    queryKey: WATCHES_KEY,
    queryFn: () => fetchWatches(),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  });
