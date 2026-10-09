"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
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
const NO_CHANGES = "No changes seen yet.";
const NOT_ADDRESS = "That isn't an address.";
const TELEGRAM_UNLINKED = "Alerts go to Telegram. Link a chat to receive them.";
const TELEGRAM_WAITING = "Press Start in the chat that opened. This link works for 10 minutes.";
const TELEGRAM_LINKED = "Telegram linked.";
/** The chat is gone (the route answered 200), but the read that would flip the view failed: a second press reads again. */
const UNLINK_UNCONFIRMED = "Couldn't confirm the unlink. Press Unlink again.";
/** The free limit the route states; the footer and the sentences read the list's own limit, which is this today. */
const FREE_LIMIT = 3;
const emptySentence = (limit: number) =>
  `No tokens watched yet. Watchdog checks a token's owner, supply, pause state, implementation and deepest pool, and sends an alert when one of them changes. You can watch up to ${limit} tokens.`;
const limitSentence = (limit: number) => `You can watch up to ${limit} tokens. Remove one to add another.`;

/** How long a link code lives (TTL_MS.linkCodes), and so how long the window asks whether the chat got linked. */
const LINK_TTL_MS = 10 * 60_000;
/** While waiting for the chat: /api/auth/me every 5 s is 12 a minute, under its 60 a minute. */
const LINK_POLL_MS = 5_000;
/**
 * The window's own read of the session, for the link poll and for Unlink. It gives up after the poll's interval, so
 * one that hangs (the phone changed networks) can't hold the next reads, or the form, back; a read that gave up
 * answers "unavailable", which moves nothing. The gate's own re-read gives up after 10 s, and a failed one puts the
 * gate in its "unavailable" view, in the body's place: the window reads first, and tells the gate only what it saw
 * change.
 */
const readSession = () => fetchSession((input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(LINK_POLL_MS) }));

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

/**
 * What the form says under the input: the route's sentence or the client check's, whether it faults the address
 * itself, and whether it is the route's 409 (the list is full: a Remove answers it).
 */
type FormError = { text: string; invalid: boolean; limit: boolean };

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

  // The list is this wallet's. It leaves the cache with the body: the window closed, or minimized (on touch, another
  // window made active), since the shell unmounts a window it doesn't show, or the body taken down by the gates when
  // the wallet signed out or changed. So the next wallet to sign in on this page loads its own list rather than seeing
  // the last wallet's, or the 401 the last poll answered, and a restored window reads its list again. The key stays
  // ["watches"] (design 6); the list is only cached while a window shows it. A change still answering when the body
  // leaves acts on nothing (see add and remove): its list, or the read a 409 asks for, would put the entry back, for
  // the next wallet to start from, and the gate it would tell of a 401 is the last wallet's.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      queryClient.removeQueries({ queryKey: WATCHES_KEY });
    };
  }, [queryClient]);

  // What the form holds now, for a change that answers after the form moved on (see add).
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

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

  // A 409's complaint says the list is full. It stands while it is: a Remove in this window answers it (see remove),
  // and so does a list the minute's poll or the focus refetch brings back under the limit (a token was removed on
  // another device), as a state adjusted during the render, like the prefill above. Any other complaint stands. The
  // list the 409 was answered under may still be below the limit (that is what the 409's refetch corrects): only the
  // limit's going, not its absence, clears the complaint.
  const [wasAtLimit, setWasAtLimit] = useState(atLimit);
  if (atLimit !== wasAtLimit) {
    setWasAtLimit(atLimit);
    if (!atLimit) setFormError((error) => (error?.limit ? null : error));
  }

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
   * otherwise answer the list from before the change and put it back over this one. Once the window has left the
   * page, nothing is written or cancelled: the cache entry is gone with it, and the next wallet's own load may be
   * under way.
   */
  const show = async (next: WatchList) => {
    if (!mounted.current) return;
    await queryClient.cancelQueries({ queryKey: WATCHES_KEY });
    if (!mounted.current) return;
    queryClient.setQueryData(WATCHES_KEY, next);
  };

  const add = async (value: string, from: "form" | "drop" = "form") => {
    const token = value.trim();
    const valid = isAddress(token, { strict: false });
    // A token the form can't send yet waits in it: a drop while a change is under way, or at the limit (the Watch
    // button is disabled either way, so nothing else gets here; the limit sentence says what to do), or while the
    // list is still on its way and there is no form on the page (it shows the token once the list has arrived).
    // Watch sends it then. What isn't an address waits with the complaint.
    if (!valid || busy || atLimit || !formShown) {
      setDraft(token);
      setFormError(valid ? null : { text: NOT_ADDRESS, invalid: true, limit: false });
      return;
    }
    setBusy(true);
    setFormError(null);
    const result = await addWatch(token);
    // The window left the page meanwhile (closed, or taken down by the gates): nothing below is for it.
    if (!mounted.current) return;
    // Watch was disabled meanwhile and couldn't keep the focus it had: the input takes it, unless the visitor moved on.
    if (from === "form") pendingFocus.current = { kind: "input" };
    if (!result.ok) {
      setBusy(false);
      refused(result);
      // The limit moved under the window (another tab or device added a token): the list on screen is stale.
      if (result.status === 409) void query.refetch();
      // The complaint is the form's while the form holds the token sent, or nothing: a dropped token goes into an
      // empty form with it, so the visitor sees what was refused; a form the visitor emptied meanwhile stays empty,
      // and isn't marked for a token it no longer holds. A form that holds another token by now (dropped, handed by
      // Inspector or typed while the route answered) keeps it, and the complaint, which isn't about it, goes to a
      // toast that names the token refused. Only the route's 400 faults the address itself; a limit or an outage says
      // nothing against it.
      const current = draftRef.current;
      const refill = from === "drop" && current === "";
      if (refill) setDraft(token);
      const own = refill || current.trim() === token;
      if (own || current === "") setFormError({ text: result.error, invalid: own && result.status === 400, limit: result.status === 409 });
      else notify(`${shortAddress(token)}: ${result.error}`, "warn");
      return;
    }
    // The token sent leaves the form; another the form was given meanwhile stays, for Watch to send.
    setDraft((current) => (current.trim() === token ? "" : current));
    await show(result.list);
    setBusy(false);
    if (result.added) trackEvent("watch_add", { watches: result.list.watches.length });
  };

  const remove = async (token: string) => {
    if (busy || !list) return;
    setBusy(true);
    const before = list.watches.map((row) => row.token);
    const result = await removeWatch(token);
    // The window left the page meanwhile: nothing below is for it (see add).
    if (!mounted.current) return;
    if (!result.ok) {
      // The row stays: focus returns to its button.
      pendingFocus.current = { kind: "row", key: token };
      setBusy(false);
      refused(result);
      return notify(result.error, "warn");
    }
    pendingFocus.current = focusAfterRemoval(before, token, result.list.watches.map((row) => row.token));
    // A row left: the last Watch's complaint that the list was full is answered. Any other complaint stands.
    setFormError((error) => (error?.limit ? null : error));
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
                <p className="text-muted">{emptySentence(limit)}</p>
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
                {/* The route's 409 says the same words as an alert: the muted sentence waits until that complaint has gone. Beside any other complaint it stays, so the disabled button is explained. */}
                {atLimit && formError?.limit !== true && <p className="text-xs text-muted">{limitSentence(limit)}</p>}
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
 * the window asks the session every 5 s, while the tab is visible and for at most the link's ten minutes (then once
 * more, visible or not), whether the chat pressed Start. Linked: an Unlink button.
 */
function Telegram({ linked, refresh }: { linked: boolean; refresh: () => Promise<void> }) {
  const { notify } = useDesktop();
  const [waiting, setWaiting] = useState<{ url: string; until: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The view follows the session the gate holds. When it flips (the chat pressed Start, Unlink's read landed, the
  // chat was linked or taken away on another device), the controls on the page are the new view's, and what the old
  // view's button had set goes with it, as a state adjusted during the render (the pattern the form uses above): the
  // button is enabled again (a press still answering acts on nothing, see `turn`), its complaint is gone (a sentence
  // under a button that left the page), and the wait ends when the linked view does (Unlink, or the chat gone on
  // another device), so the ask comes back without a stale link. A wait outlives the flip to linked: the toast below
  // reads it.
  const [seenLinked, setSeenLinked] = useState(linked);
  if (linked !== seenLinked) {
    setSeenLinked(linked);
    setBusy(false);
    setError(null);
    if (!linked) setWaiting(null);
  }

  // Every continuation below (a route's answer, Unlink's own session read) acts only for the section as it was at the
  // press: on the page, in the same view, with no later press. `turn` counts the moves: a press (`begin`), the view
  // flipping (the layout effect, in the commit itself, so no answer can land between the flip and the count) and the
  // section leaving the page (the window closed, or minimized, on touch another window made active, since the shell
  // unmounts a window it doesn't show; or the gates took the body down). The wait leaves with the section: a window
  // restored after Link Telegram shows the ask again, and a press then makes a new code (the first code's chat,
  // pressing Start, is linked all the same; only its toast isn't shown). A continuation checks the count
  // right after each await (`movedOn`) and returns when it has moved: what it would have done belongs to a view or a
  // press that has gone. The gate it would tell of a 401 is the last wallet's (its refresh closure reads the session
  // for that wallet's address), the tab it would open is for a chat already linked or a window that is gone, the
  // event it would count is for a link the visitor never saw, and the sentence it would set is under a button that
  // isn't there, or is a later press's to set.
  const turn = useRef(0);
  const begin = () => ++turn.current;
  const movedOn = (mine: number) => mine !== turn.current;
  useLayoutEffect(() => {
    turn.current += 1;
    return () => {
      turn.current += 1;
    };
  }, [linked]);

  // The poll reads /api/auth/me itself (readSession) and hands the gate only an answer that changes it: the chat
  // pressed Start (linked), or the session is gone (null, so the sign-in prompt comes back). A read that fails, or
  // still says unlinked, leaves the window waiting: a single failed read out of the wait's hundred-odd would
  // otherwise put the gate in its "unavailable" view and take the window, with the link, away. One read at a time,
  // and only while the tab is visible: the link itself hides it (the t.me tab, or Telegram on the phone, takes its
  // place). Once the code's ten minutes are up, the tick reads once more, visible or not: the chat may have pressed
  // Start while the tab was hidden, or since the last read, and the wait would otherwise end on the ask, with alerts
  // already going to the chat and a press of Link Telegram spending a code to link it again. A last read that says
  // linked, or signed out, tells the gate and keeps the wait, which the linked view ends (the toast below reads it);
  // the ticks read on until the gate has answered. One that says unlinked, or fails, ends the wait: the ask comes
  // back, and a press makes a new code.
  useEffect(() => {
    if (!waiting || linked) return;
    let live = true;
    let asking = false;
    const timer = setInterval(() => {
      const last = Date.now() >= waiting.until;
      if (asking || (!last && document.visibilityState !== "visible")) return;
      asking = true;
      void readSession()
        .then((session) => {
          if (!live) return;
          if (session === null || (session !== "unavailable" && session.telegram === "linked")) void refresh();
          else if (last) setWaiting(null);
        })
        .finally(() => {
          asking = false;
        });
    }, LINK_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [waiting, linked, refresh]);

  // The chat pressed Start: the session now says linked, and the window says so once. The wait ends with the link
  // (the linked view takes over, and the interval above stops); the flip back to unlinked clears it (above), so the
  // ask comes back.
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
  // anchor as the wait begins (the way in, too, for a browser that let no tab open), the Unlink button when the chat
  // got linked while the anchor had the focus, and the Link Telegram button when the wait has run out or Unlink has
  // ended the chat. A visitor who moved on meanwhile keeps their focus.
  const againRef = useRef<HTMLAnchorElement>(null);
  const linkRef = useRef<HTMLButtonElement>(null);
  const unlinkRef = useRef<HTMLButtonElement>(null);
  const view = linked ? "linked" : waiting ? "waiting" : "unlinked";
  const lastView = useRef(view);
  useEffect(() => {
    const from = lastView.current;
    lastView.current = view;
    if (from === view || !focusWasLost()) return;
    if (view === "waiting") againRef.current?.focus();
    else if (view === "unlinked") linkRef.current?.focus();
    else unlinkRef.current?.focus();
  }, [view]);

  const link = async () => {
    if (busy) return;
    const mine = begin();
    setBusy(true);
    setError(null);
    const result = await linkTelegram();
    // The section moved on meanwhile (it left the page, or the gate's session flipped to linked): nothing below is
    // for it (see `turn`).
    if (movedOn(mine)) return;
    setBusy(false);
    if (!result.ok) {
      if (result.status === 401) void refresh();
      return setError(result.error);
    }
    trackEvent("telegram_link");
    setWaiting({ url: result.url, until: Date.now() + LINK_TTL_MS });
    window.open(result.url, "_blank", "noopener,noreferrer");
  };

  // The chat is gone once the route has answered (or so is the session: a 401). The form is released then: the view
  // follows the session the gate holds, which is read again, but no read holds the Unlink button (a second press
  // repeats a DELETE the route answers 200 to, and reads again). The window reads first, with readSession's timeout,
  // and tells the gate only when the read answered: the gate's own re-read, failing, would show its "unavailable"
  // view in the body's place, list and form included, until the window is opened again. A read that fails leaves the
  // linked view and says so under it, with Unlink to press again; the button takes the focus it dropped while it was
  // disabled (below). The Link Telegram button takes the focus as the view changes (above). A second press while the
  // first's read is still out (nothing on the page says it is) reads for itself, and the first press is over: its
  // read, landing late, says nothing, neither the sentence under the view the second press moved the section to, nor
  // a word to the gate the second press's read may yet fail to give (that press says so then, with Unlink to press
  // again).
  const unlink = async () => {
    if (busy) return;
    const mine = begin();
    setBusy(true);
    setError(null);
    const result = await unlinkTelegram();
    // The section moved on meanwhile (it left the page, or the gate's session flipped): nothing below is for it (see
    // `turn`).
    if (movedOn(mine)) return;
    setBusy(false);
    if (!result.ok && result.status !== 401) return setError(result.error);
    if (!result.ok) {
      void refresh();
      return setError(result.error);
    }
    const session = await readSession();
    // A later press, or the view flipping on its own, is the section's now (see `turn`).
    if (movedOn(mine)) return;
    if (session === "unavailable") return setError(UNLINK_UNCONFIRMED);
    void refresh();
  };

  // The read after Unlink failed: the sentence is on the page, and the button, enabled again, takes the focus it
  // dropped to the body while it was disabled, unless the visitor moved on meanwhile.
  useEffect(() => {
    if (error === UNLINK_UNCONFIRMED && focusWasLost()) unlinkRef.current?.focus();
  }, [error]);

  return (
    <section aria-label="Telegram" className="grid gap-2 border-t border-border pt-3">
      {linked ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p>{TELEGRAM_LINKED}</p>
          <button ref={unlinkRef} type="button" className={BUTTON} disabled={busy} onClick={() => void unlink()}>
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
