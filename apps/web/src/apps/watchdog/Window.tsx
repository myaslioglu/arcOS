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
import { fetchSession } from "@/lib/sign-in-client";
import {
  UNAVAILABLE,
  WATCHES_KEY,
  WatchFetchError,
  addWatch,
  linkTelegram,
  removeWatch,
  unlinkTelegram,
  watchesQueryOptions,
  type Refusal,
  type WatchItem,
  type WatchList,
} from "./api";
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
 * Whether focus was lost: nothing holds it, or the page body does, which is where it lands when the element that had
 * it left the page or was disabled. A visitor who has moved on meanwhile keeps their place.
 */
const focusWasLost = () => document.activeElement === null || document.activeElement === document.body;

/**
 * The params objects whose token has prefilled the form. The shell keeps one params object per open, so an open
 * prefills once: Watches mounts anew under the gates whenever the wallet signs in again, and doesn't prefill again.
 */
const prefilled = new WeakSet<object>();

/** What the form says under the input: the route's sentence or the client check's, and whether it faults the address itself. */
type FormError = { text: string; invalid: boolean };

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

/** Where focus goes once a Remove has ended: a row's Remove button, or the add-token input. */
type FocusTarget = { kind: "row"; key: string } | { kind: "input" };

/**
 * Where focus goes after a row left the list: the row now in its place, else the last row, else the add-token input.
 * `before` is the list the Remove was clicked in, `after` the list the route answered.
 */
function focusAfterRemoval(before: readonly string[], removed: string, after: readonly string[]): FocusTarget {
  if (after.length === 0) return { kind: "input" };
  const idx = Math.max(0, before.indexOf(removed));
  return { kind: "row", key: after[Math.min(idx, after.length - 1)]! };
}

function Watches({ params }: { params: Record<string, string> }) {
  const session = useSession();
  const refresh = session.refresh;
  const { notify } = useDesktop();
  const queryClient = useQueryClient();
  const query = useQuery(watchesQueryOptions());
  const list = query.data;
  const limit = list?.limit || FREE_LIMIT;
  const atLimit = list !== undefined && list.watches.length >= limit;
  // The form, with its input, is on the page once the list is.
  const formShown = list !== undefined;

  const inputId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const [formError, setFormError] = useState<FormError | null>(null);
  // One change at a time: a second Watch or Remove waits for the first, so the list the route answers is the last one.
  const [busy, setBusy] = useState(false);

  // The list is this wallet's. It leaves the cache with the window (closed, or taken down by the gates when the wallet
  // signed out or changed), so the next wallet to sign in on this page loads its own list rather than seeing the last
  // wallet's, or the 401 the last poll answered. The key stays ["watches"] (design 6); the list is only cached while
  // a window shows it.
  useEffect(
    () => () => {
      queryClient.removeQueries({ queryKey: WATCHES_KEY });
    },
    [queryClient],
  );

  // Inspector's button, or a deep link, names a token: it goes into the form, which gets focus. Nothing is sent. The
  // shell stores a fresh params object on every open that carries params, and keeps it between renders, so the form
  // follows each open, the same token again included, as a state adjusted during the render (React's pattern for
  // state that follows a prop), once per params object (`prefilled`, noted after the commit): a token prefilled
  // before the wallet signed in again isn't prefilled again when Watches remounts under the gates. Only the focus,
  // outside React, waits for the commit, and for the form to be on the page: on a fresh open the list is still
  // loading, and the input isn't there to focus until it has arrived.
  const [seenParams, setSeenParams] = useState<Record<string, string> | null>(null);
  const [prefill, setPrefill] = useState<Record<string, string> | null>(null);
  if (params !== seenParams) {
    setSeenParams(params);
    if (params.token && !prefilled.has(params)) {
      setPrefill(params);
      setDraft(params.token);
      setFormError(null);
    }
  }
  useEffect(() => {
    if (prefill) prefilled.add(prefill);
  }, [prefill]);
  useEffect(() => {
    if (prefill && formShown) inputRef.current?.focus();
  }, [prefill, formShown]);

  // The routes answer 401 once the session is gone: the cookie expired under an open window, or the wallet signed out
  // elsewhere. The gate is told (it reads the session again and shows the sign-in prompt); each new 401 tells it once.
  const unauthorized = query.error instanceof WatchFetchError && query.error.status === 401 ? query.error : null;
  useEffect(() => {
    if (unauthorized) void refresh();
  }, [unauthorized, refresh]);
  const refused = (result: Refusal) => {
    if (result.status === 401) void refresh();
  };

  // Where focus goes once a change has ended. add() and remove() only store it: Watch and every Remove button are
  // disabled while busy, and a disabled button can't hold focus, so the effect acts once busy is false again, after
  // the list has re-rendered. It moves focus only if it was lost; a visitor who tabbed elsewhere meanwhile keeps it.
  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const pendingFocus = useRef<FocusTarget | null>(null);
  useEffect(() => {
    if (busy) return;
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    if (!focusWasLost()) return;
    const row = target.kind === "row" ? rowRefs.current[target.key] : null;
    (row ?? inputRef.current)?.focus();
  }, [busy]);

  /**
   * The route's list after a change is the list: it replaces the query's data without another fetch. A refresh still
   * in flight (the minute's poll, or the focus that came back from the Telegram tab) is cancelled first: it would
   * otherwise answer the list from before the change and put it back over this one.
   */
  const show = async (next: WatchList) => {
    await queryClient.cancelQueries({ queryKey: WATCHES_KEY });
    queryClient.setQueryData(WATCHES_KEY, next);
  };

  const add = async (value: string, from: "form" | "drop" = "form") => {
    const token = value.trim();
    const valid = isAddress(token, { strict: false });
    // A token the form can't send yet waits in it: a drop while a change is under way (the Watch button is disabled,
    // so nothing else gets here), or while the list is still on its way and there is no form on the page (it shows
    // the token once the list has arrived). Watch sends it then. What isn't an address waits with the complaint.
    if (!valid || busy || !formShown) {
      setDraft(token);
      setFormError(valid ? null : { text: NOT_ADDRESS, invalid: true });
      return;
    }
    setBusy(true);
    setFormError(null);
    const result = await addWatch(token);
    // Watch was disabled meanwhile and couldn't keep the focus it had: the input takes it, unless the visitor moved on.
    if (from === "form") pendingFocus.current = { kind: "input" };
    if (!result.ok) {
      setBusy(false);
      refused(result);
      setDraft(token);
      // Only the route's 400 faults the address itself; a limit or an outage says nothing against it.
      setFormError({ text: result.error, invalid: result.status === 400 });
      return;
    }
    setDraft("");
    await show(result.list);
    setBusy(false);
    if (result.added) trackEvent("watch_add", { watches: result.list.watches.length });
  };

  const remove = async (token: string) => {
    if (busy || !list) return;
    setBusy(true);
    const before = list.watches.map((row) => row.token);
    const result = await removeWatch(token);
    if (!result.ok) {
      // The row stays: focus returns to its button.
      pendingFocus.current = { kind: "row", key: token };
      setBusy(false);
      refused(result);
      return notify(result.error, "warn");
    }
    pendingFocus.current = focusAfterRemoval(before, token, result.list.watches.map((row) => row.token));
    await show(result.list);
    setBusy(false);
  };

  // A token file dropped on the window is watched: only its address is read, as the form would read it typed. Before
  // the list has arrived, or while a change is under way, the token waits in the form (see add).
  const { over, props: dropProps } = useDropTarget(watchdog.acceptsDrop, (item) => {
    if (item.kind === "token") void add(item.address, "drop");
  });

  return (
    <div className={`flex h-full flex-col text-sm ${over ? "outline outline-2 outline-accent" : ""}`} {...dropProps}>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {/* Always mounted, so a screen reader hears the text when it arrives: a live region mounted with its text is never announced. */}
        <p className="text-muted" role="status" aria-live="polite">
          {query.isPending ? LOADING : ""}
        </p>
        <div className="grid gap-3">
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
                    <Row
                      key={row.token}
                      row={row}
                      busy={busy}
                      remove={() => void remove(row.token)}
                      buttonRef={(el) => {
                        rowRefs.current[row.token] = el;
                      }}
                    />
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
                    aria-invalid={formError?.invalid === true}
                    aria-describedby={formError !== null ? errorId : undefined}
                    className={INPUT}
                  />
                  <button type="submit" className={BUTTON} disabled={busy || atLimit}>
                    Watch
                  </button>
                </div>
                {atLimit && <p className="text-xs text-muted">{limitSentence(limit)}</p>}
                {formError && (
                  <p id={errorId} className="text-xs text-danger-text" role="alert">
                    {formError.text}
                  </p>
                )}
              </form>
              <Telegram linked={session.telegram === "linked"} refresh={refresh} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ row, busy, remove, buttonRef }: { row: WatchItem; busy: boolean; remove: () => void; buttonRef: (el: HTMLButtonElement | null) => void }) {
  const short = shortAddress(row.token);
  const name = row.symbol ?? short;
  // Symbols aren't unique (a look-alike copies one on purpose), so the button's name carries the address too.
  const label = row.symbol === null ? `Remove ${short}` : `Remove ${row.symbol} ${short}`;
  return (
    <li className="grid gap-1 rounded-lg border border-border bg-surface px-3 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        {/* A line breaks only where it must (wrap-anywhere, which the grid's columns also measure by), and never inside the address. */}
        <p className="min-w-0 wrap-anywhere">
          <span className="font-medium">{name}</span>{" "}
          <span className="font-mono text-xs whitespace-nowrap text-muted" title={row.token}>
            {short}
          </span>
        </p>
        <button ref={buttonRef} type="button" className={BUTTON} disabled={busy} aria-label={label} onClick={remove}>
          Remove
        </button>
      </div>
      <p className="wrap-anywhere text-xs text-muted">
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

  // The poll reads /api/auth/me itself and hands the gate only an answer that changes it: the chat pressed Start
  // (linked), or the session is gone (null, so the sign-in prompt comes back). A read that fails, or still says
  // unlinked, leaves the window waiting: a single failed read out of the wait's hundred-odd would otherwise put the
  // gate in its "unavailable" view and take the window, with the link, away. One read at a time.
  useEffect(() => {
    if (!waiting || linked) return;
    let live = true;
    let asking = false;
    const timer = setInterval(() => {
      if (Date.now() >= waiting.until) {
        setWaiting(null);
        return;
      }
      if (document.visibilityState !== "visible" || asking) return;
      asking = true;
      void fetchSession().then((session) => {
        asking = false;
        if (!live) return;
        if (session === null || (session !== "unavailable" && session.telegram === "linked")) void refresh();
      });
    }, LINK_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
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

  // The section's views replace one another's controls, and the one that had focus drops it to the body as it leaves
  // the page. The view that comes next takes it, so a keyboard user keeps their place: the "Open the link again"
  // anchor as the wait begins (the way in, too, for a browser that let no tab open), and the Link Telegram button
  // when the wait has run out or Unlink has ended the chat. A visitor who moved on meanwhile keeps their focus.
  const againRef = useRef<HTMLAnchorElement>(null);
  const linkRef = useRef<HTMLButtonElement>(null);
  const view = linked ? "linked" : waiting ? "waiting" : "unlinked";
  const lastView = useRef(view);
  useEffect(() => {
    const from = lastView.current;
    lastView.current = view;
    if (from === view || !focusWasLost()) return;
    if (view === "waiting") againRef.current?.focus();
    else if (view === "unlinked") linkRef.current?.focus();
  }, [view]);

  const link = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await linkTelegram();
    setBusy(false);
    if (!result.ok) {
      if (result.status === 401) void refresh();
      return setError(result.error);
    }
    trackEvent("telegram_link");
    setWaiting({ url: result.url, until: Date.now() + LINK_TTL_MS });
    window.open(result.url, "_blank", "noopener,noreferrer");
  };

  const unlink = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await unlinkTelegram();
    if (result.ok || result.status === 401) {
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
          <a ref={againRef} href={waiting.url} target="_blank" rel="noreferrer noopener" className={LINK}>
            Open the link again
          </a>
        </p>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-muted">{TELEGRAM_UNLINKED}</p>
          <button ref={linkRef} type="button" className={BUTTON} disabled={busy} onClick={() => void link()}>
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
