import type { DeliveryError } from "@arcos/data";

// Watchdog's one channel (design 3.2): the Bot API's sendMessage, called from the function alone. The bot token lives
// in the closure `telegramSender` makes and nowhere else: no outcome, error, log line or URL this module hands out
// carries it, and a caller gets a short code per send, never Telegram's answer, its body or its message.

/** What one send came to. Codes only. */
export type SendOutcome =
  | { kind: "ok" }
  /** The chat blocked the bot (403): terminal, and the wallet is unlinked. */
  | { kind: "blocked" }
  /** The chat is gone (400 "chat not found"): terminal, and the wallet is unlinked. */
  | { kind: "chat_not_found" }
  /** Any other 400: terminal, the message itself was refused. */
  | { kind: "bad_request" }
  /** 429: the bot is sending too fast. No attempt is counted; sends stop until `retryAfterSec` has passed. */
  | { kind: "rate_limited"; retryAfterSec: number }
  /** 401 or 404: the token is wrong or revoked. No attempt is counted; sends stop for a while. */
  | { kind: "unauthorized" }
  /** Telegram's side failed: retried on a later run. */
  | { kind: "telegram_5xx"; status: number }
  /** No answer within the timeout: retried on a later run. */
  | { kind: "timeout" }
  /** The request never got an HTTP answer: retried on a later run. */
  | { kind: "network" };

/** The outcomes a delivery doc records as its `error` (the pauses are the instance's, not the delivery's). */
export type RecordedOutcome = Extract<SendOutcome["kind"], DeliveryError>;

export interface TelegramSender {
  /** Sends `text` as plain text (no parse_mode, no link preview) to `chatId`. Never rejects. */
  send(chatId: number, text: string): Promise<SendOutcome>;
}

/**
 * A bot token as BotFather issues it: the bot's numeric id, a colon, then 35 or so characters of base64url. A secret
 * value that doesn't match (an empty one, or "none") means "not configured", and the step makes no send.
 */
export const BOT_TOKEN_FORMAT = /^\d{5,16}:[A-Za-z0-9_-]{30,64}$/;

/** How long one send may take. The step's send phase fits a few of these before the run's send limit. */
export const SEND_TIMEOUT_MS = 4_000;

/** How long sends stop on this instance after a 401 or 404: long enough for a revoked token to be noticed, short enough to pick up a rotated one. */
export const UNAUTHORIZED_PAUSE_MS = 10 * 60_000;

/** The pause a 429 asks for is honoured between these bounds. */
export const RATE_LIMIT_PAUSE = { minSec: 1, maxSec: 3_600 } as const;

/** The Bot API host. The token goes in the path, as the API demands; the URL is built per send and never kept or logged. */
const API = "https://api.telegram.org";

type Body = { ok?: unknown; description?: unknown; parameters?: { retry_after?: unknown } };

/** The answer's JSON, if it is an object; nothing of it is kept beyond this call. */
async function bodyOf(res: Response): Promise<Body> {
  try {
    const parsed: unknown = await res.json();
    return typeof parsed === "object" && parsed !== null ? (parsed as Body) : {};
  } catch {
    return {};
  }
}

const isTimeout = (e: unknown): boolean =>
  typeof e === "object" && e !== null && ((e as { name?: unknown }).name === "TimeoutError" || (e as { name?: unknown }).name === "AbortError");

/**
 * A sender over the Bot API with `token`. `fetchFn` is for the tests. Each send is one POST of
 * `{chat_id, text, link_preview_options: {is_disabled: true}}` with no parse_mode, so nothing in `text` is markup, cut
 * off after SEND_TIMEOUT_MS. The outcome is a code read from the HTTP status (and, for a 400 and a 429, two fields of
 * the body); the body is dropped, and the request's URL is never surfaced.
 */
export function telegramSender(options: { token: string; fetchFn?: typeof fetch }): TelegramSender {
  const { token } = options;
  const fetchFn = options.fetchFn ?? fetch;
  return {
    async send(chatId, text) {
      let res: Response;
      try {
        res = await fetchFn(`${API}/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          redirect: "error",
        });
      } catch (e) {
        return isTimeout(e) ? { kind: "timeout" } : { kind: "network" };
      }
      const { status } = res;
      if (status === 200) {
        const body = await bodyOf(res);
        return body.ok === false ? { kind: "bad_request" } : { kind: "ok" };
      }
      if (status === 403) return { kind: "blocked" };
      if (status === 401 || status === 404) return { kind: "unauthorized" };
      if (status === 429) {
        const body = await bodyOf(res);
        const asked = body.parameters?.retry_after;
        const seconds = typeof asked === "number" && Number.isFinite(asked) ? Math.ceil(asked) : RATE_LIMIT_PAUSE.minSec;
        return { kind: "rate_limited", retryAfterSec: Math.min(RATE_LIMIT_PAUSE.maxSec, Math.max(RATE_LIMIT_PAUSE.minSec, seconds)) };
      }
      if (status === 400) {
        const body = await bodyOf(res);
        return typeof body.description === "string" && /chat not found/i.test(body.description) ? { kind: "chat_not_found" } : { kind: "bad_request" };
      }
      if (status >= 500 && status <= 599) return { kind: "telegram_5xx", status };
      // Any other status (a 3xx the redirect policy let through, an unexpected 4xx): the message was not accepted.
      return { kind: "bad_request" };
    },
  };
}
