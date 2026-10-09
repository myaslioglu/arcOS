"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isAddress } from "viem";
import { activeNetwork } from "@arcos/chain";
import { useDesktop, useDropTarget, type AppProps } from "@arcos/shell";
import { ConnectGate } from "@/components/ConnectGate";
import { SignInGate, useSession } from "@/components/SignInGate";
import { trackEvent } from "@/lib/analytics";
import { shortAddress } from "@/lib/format";
import { UNAVAILABLE, WATCHES_KEY, addWatch, linkTelegram, removeWatch, unlinkTelegram, watchesQueryOptions, type WatchItem, type WatchList } from "./api";
import { watchdog } from "./manifest";

/** Every control is at least 32px high, 44px on touch. */
const BUTTON = "min-h-8 rounded-md border border-border-2 px-3 text-xs pointer-coarse:min-h-11 disabled:opacity-50";
const INPUT = "min-h-8 min-w-0 flex-1 rounded-md border border-border-2 bg-surface px-2 font-mono text-xs pointer-coarse:min-h-11 pointer-coarse:text-base";
const LINK = "text-accent-text underline";

const OFF_MAINNET = "Watchdog runs on Arc mainnet only.";
const LOADING = "Loading your watches.";
const EMPTY =
  "No tokens watched yet. Watchdog checks a token's owner, supply, pause state, implementation and deepest pool, and sends an alert when one of them changes. You can watch up to 3 tokens.";
const NO_CHANGES = "No changes seen yet.";
const NOT_ADDRESS = "That isn't an address.";
const TELEGRAM_UNLINKED = "Alerts go to Telegram. Link a chat to receive them.";
const TELEGRAM_WAITING = "Press Start in the chat that opened. This link works for 10 minutes.";
const TELEGRAM_LINKED = "Telegram linked.";
/** The free limit the route states; the footer and the limit sentence read the list's own, which is this today. */
const FREE_LIMIT = 3;
const limitSentence = (limit: number) => `You can watch up to ${limit} tokens. Remove one to add another.`;

/** How long a link code lives (TTL_MS.linkCodes), and so how long the window asks whether the chat got linked. */
const LINK_TTL_MS = 10 * 60_000;
/** While waiting for the chat: /api/auth/me every 5 s is 12 a minute, under its 60 a minute. */
const LINK_POLL_MS = 5_000;

/**
 * Watchdog: the tokens the signed-in wallet watches on Arc mainnet, each with its newest alert, polled every minute;
 * a form (and a drop target) to watch one more, up to the free limit; and the wallet's Telegram chat, where the alerts
 * go. The wallet connects and signs in first (ConnectGate, SignInGate). The testnet site has no watches: its window
 * says so, and asks for nothing. A `token` param (Inspector's "Watch with Watchdog") only prefills the form.
 */
export default function WatchdogWindow({ params }: AppProps) {
  if (activeNetwork() !== "mainnet") {
    return (
      <div className="p-3 text-sm">
        <p className="text-muted">{OFF_MAINNET}</p>
      </div>
    );
  }
  return (
    <ConnectGate>
      <SignInGate>
        <Watches params={params} />
      </SignInGate>
    </ConnectGate>
  );
}

function Watches({ params }: { params: Record<string, string> }) {
  const session = useSession();
  const { notify } = useDesktop();
  const queryClient = useQueryClient();
  const query = useQuery(watchesQueryOptions());
  const list = query.data;
  const limit = list?.limit || FREE_LIMIT;
  const atLimit = list !== undefined && list.watches.length >= limit;

  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  // One change at a time: a second Watch or Remove waits for the first, so the list the route answers is the last one.
  const [busy, setBusy] = useState(false);

  // Inspector's button, or a deep link, names a token: it goes into the form, which gets focus. Nothing is sent. The
  // shell replaces the params of an open window, so the form follows each new token, as a state adjusted during the
  // render (React's pattern for state that follows a prop); only the focus, outside React, waits for the commit.
  const [seenToken, setSeenToken] = useState<string | undefined>(undefined);
  if (params.token !== seenToken) {
    setSeenToken(params.token);
    if (params.token) {
      setDraft(params.token);
      setFormError(null);
    }
  }
  useEffect(() => {
    if (params.token) inputRef.current?.focus();
  }, [params.token]);

  /** The route's list after a change is the list: it replaces the query's data without another fetch. */
  const show = (next: WatchList) => queryClient.setQueryData(WATCHES_KEY, next);

  const add = async (value: string) => {
    const token = value.trim();
    if (!isAddress(token, { strict: false })) {
      setDraft(token);
      setFormError(NOT_ADDRESS);
      return;
    }
    if (busy) return;
    setBusy(true);
    setFormError(null);
    const result = await addWatch(token);
    setBusy(false);
    if (!result.ok) {
      setDraft(token);
      setFormError(result.error);
      return;
    }
    setDraft("");
    show(result.list);
    if (result.added) trackEvent("watch_add", { watches: result.list.watches.length });
  };

  const remove = async (token: string) => {
    if (busy) return;
    setBusy(true);
    const result = await removeWatch(token);
    setBusy(false);
    if (!result.ok) return notify(result.error, "warn");
    show(result.list);
  };

  // A token file dropped on the window is watched: only its address is read, as the form would read it typed.
  const { over, props: dropProps } = useDropTarget(watchdog.acceptsDrop, (item) => {
    if (item.kind === "token") void add(item.address);
  });

  return (
    <div className={`flex h-full flex-col text-sm ${over ? "outline outline-2 outline-accent" : ""}`} {...dropProps}>
      <div className="grid min-h-0 flex-1 content-start gap-3 overflow-auto p-3">
        {/* Always mounted, so a screen reader hears the text when it arrives: a live region mounted with its text is never announced. */}
        <p className="text-muted" role="status" aria-live="polite">
          {query.isPending ? LOADING : ""}
        </p>
        {query.isLoadingError && (
          <div className="grid justify-items-start gap-2">
            <p className="text-danger-text" role="alert">
              {UNAVAILABLE}
            </p>
            <button type="button" className={BUTTON} onClick={() => void query.refetch()}>
              Retry
            </button>
          </div>
        )}
        {list && (
          <>
            {query.isRefetchError && (
              <p className="text-xs text-muted" role="status">
                {"Couldn't refresh the list. Showing the last one."}
              </p>
            )}
            {list.watches.length === 0 ? (
              <p className="text-muted">{EMPTY}</p>
            ) : (
              <ul aria-label="Watched tokens" className="grid gap-2">
                {list.watches.map((row) => (
                  <Row key={row.token} row={row} busy={busy} remove={() => void remove(row.token)} />
                ))}
              </ul>
            )}
            <p className="text-xs text-muted">{`${list.watches.length} of ${limit} tokens watched.`}</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void add(draft);
              }}
              className="grid gap-2"
            >
              <label htmlFor={inputId} className="text-xs text-muted">
                Add a token
              </label>
              <div className="flex flex-wrap gap-2">
                <input
                  ref={inputRef}
                  id={inputId}
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    setFormError(null);
                  }}
                  placeholder="Token address (0x…)"
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={formError !== null}
                  className={INPUT}
                />
                <button type="submit" className={BUTTON} disabled={busy || atLimit}>
                  Watch
                </button>
              </div>
              {atLimit && <p className="text-xs text-muted">{limitSentence(limit)}</p>}
              {formError && (
                <p className="text-xs text-danger-text" role="alert">
                  {formError}
                </p>
              )}
            </form>
            <Telegram linked={session.telegram === "linked"} refresh={session.refresh} />
          </>
        )}
      </div>
    </div>
  );
}

function Row({ row, busy, remove }: { row: WatchItem; busy: boolean; remove: () => void }) {
  const name = row.symbol ?? shortAddress(row.token);
  return (
    <li className="grid gap-1 rounded-lg border border-border bg-surface px-3 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="min-w-0 break-all">
          <span className="font-medium">{name}</span>{" "}
          <span className="font-mono text-xs text-muted" title={row.token}>
            {shortAddress(row.token)}
          </span>
        </p>
        <button type="button" className={BUTTON} disabled={busy} aria-label={`Remove ${name}`} onClick={remove}>
          Remove
        </button>
      </div>
      <p className="break-words text-xs text-muted">
        {row.latestAlert === null ? (
          NO_CHANGES
        ) : row.latestAlert.link === null ? (
          row.latestAlert.text
        ) : (
          <a href={row.latestAlert.link} target="_blank" rel="noreferrer noopener" className={LINK}>
            {row.latestAlert.text}
          </a>
        )}
      </p>
    </li>
  );
}

/**
 * The wallet's Telegram chat. Unlinked: a button that asks the route for a t.me link and opens it in a new tab, then
 * the window asks the session every 5 s, while the tab is visible and for at most the link's ten minutes, whether the
 * chat pressed Start. Linked: an Unlink button.
 */
function Telegram({ linked, refresh }: { linked: boolean; refresh: () => Promise<void> }) {
  const { notify } = useDesktop();
  const [waiting, setWaiting] = useState<{ url: string; until: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!waiting || linked) return;
    const timer = setInterval(() => {
      if (Date.now() >= waiting.until) {
        setWaiting(null);
        return;
      }
      if (document.visibilityState === "visible") void refresh();
    }, LINK_POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, linked, refresh]);

  // The chat pressed Start: the session now says linked, and the window says so once. The wait ends with the link
  // (the linked view takes over, and the interval above stops); Unlink clears it, so the ask comes back.
  const announced = useRef(false);
  useEffect(() => {
    if (!linked) {
      announced.current = false;
      return;
    }
    if (waiting && !announced.current) {
      announced.current = true;
      notify(TELEGRAM_LINKED, "ok");
    }
  }, [linked, waiting, notify]);

  const link = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await linkTelegram();
    setBusy(false);
    if (!result.ok) return setError(result.error);
    trackEvent("telegram_link");
    setWaiting({ url: result.url, until: Date.now() + LINK_TTL_MS });
    window.open(result.url, "_blank", "noopener,noreferrer");
  };

  const unlink = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await unlinkTelegram();
    if (result.ok) {
      setWaiting(null);
      await refresh();
    }
    setBusy(false);
    if (!result.ok) setError(result.error);
  };

  return (
    <section aria-label="Telegram" className="grid gap-2 border-t border-border pt-3">
      {linked ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p>{TELEGRAM_LINKED}</p>
          <button type="button" className={BUTTON} disabled={busy} onClick={() => void unlink()}>
            Unlink
          </button>
        </div>
      ) : waiting ? (
        <p className="text-muted">
          {TELEGRAM_WAITING}{" "}
          <a href={waiting.url} target="_blank" rel="noreferrer noopener" className={LINK}>
            Open the link again
          </a>
        </p>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-muted">{TELEGRAM_UNLINKED}</p>
          <button type="button" className={BUTTON} disabled={busy} onClick={() => void link()}>
            Link Telegram
          </button>
        </div>
      )}
      {error && (
        <p className="text-xs text-danger-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
