"use client";

import { useDeferredValue, useEffect, useMemo, useState, useSyncExternalStore, type ChangeEvent, type DragEvent } from "react";
import { useReadContracts } from "wagmi";
import { erc20Abi, formatUnits, isAddress } from "viem";
import { ARCOS, USDC, activeChain, activeNetwork, formatUsdc, unitsToNative, type Address } from "@arcos/chain";
import { cleanLabel } from "@arcos/inspector";
import { dropParams, useDesktop, useDropTarget, type AppProps } from "@arcos/shell";
import { ConnectGate } from "@/components/ConnectGate";
import { describeContractError } from "@/lib/contract-error";
import { trackEvent } from "@/lib/analytics";
import { shortAddress } from "@/lib/format";
import { resolveDropAsset } from "./asset";
import { canSend } from "./canSend";
import { failedRowsText } from "./clipboard";
import { dropFeeText } from "./dropFee";
import { IssuesList } from "./IssuesList";
import { drop } from "./manifest";
import { BATCH, formatDropList, parseDropList } from "./parse";
import { canDismissResult, remainingBannerText } from "./result";
import { ResultPanel } from "./ResultPanel";
import { session } from "./session";
import { useDrop, type DropQuote } from "./useDrop";

const MAX_FILE_BYTES = 2_000_000;
const isUsdc = (addr: string) => addr.toLowerCase() === USDC.toLowerCase();

type Mode = "usdc" | "token";

function Form({ params }: Pick<AppProps, "params">) {
  const chain = activeChain();
  const contracts = ARCOS[activeNetwork()];
  const { open, notify } = useDesktop();
  const { ready, quoteTotal, send } = useDrop();

  // The send session lives outside this component (see ./session) so it survives the window closing mid
  // send. This subscription is what makes a reopened window show the send in progress, or its result,
  // instead of a blank form.
  const dropSession = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const sessionActive = dropSession.status === "sending";

  const prefilled = isAddress(params.token ?? "", { strict: false }) ? (params.token as Address) : null;
  const [mode, setMode] = useState<Mode>(prefilled && !isUsdc(prefilled) ? "token" : "usdc");
  const [tokenAddr, setTokenAddr] = useState(prefilled && !isUsdc(prefilled) ? prefilled : "");
  const [text, setText] = useState(() => {
    const snap = session.getSnapshot();
    return snap.status === "done" ? snap.remainingText : "";
  });
  const [busy, setBusy] = useState(false);
  const [fetchedQuote, setFetchedQuote] = useState<DropQuote | "error" | null>(null);

  const { over, props: dropProps } = useDropTarget(drop.acceptsDrop, (item) => open("drop", dropParams(item)));

  // A prefilled or dropped token drives the picker: USDC selects native mode (cheaper, no approval), any
  // other address selects "Another token" with that address. This is the React-endorsed "adjust state
  // during render" pattern (not an effect) so it also re-applies when an already-open Drop window is handed
  // a new token — Finder's "Send with Drop", or a token dropped on this window — without an extra render.
  const [syncedPrefilled, setSyncedPrefilled] = useState(prefilled);
  if (prefilled !== syncedPrefilled) {
    setSyncedPrefilled(prefilled);
    if (prefilled) {
      if (isUsdc(prefilled)) {
        setMode("usdc");
      } else {
        setMode("token");
        setTokenAddr(prefilled);
      }
    }
  }

  // Same pattern: once a session finishes, pull its `remainingText` — and the token it was actually sent
  // in — into the form exactly once per finished session (keyed on `startedAt`, not `remainingText` itself,
  // so further edits the user makes to the prefilled text aren't stomped on every render). The token picker
  // must follow along too: a reopened window's `mode`/`tokenAddr` reset to their defaults, and parsing the
  // prefilled remainder under the wrong token's decimals would misread every amount in it. Covers both a
  // session finishing while this window stays mounted, and a window reopened onto an already-finished one.
  const [syncedDoneAt, setSyncedDoneAt] = useState<number | null>(null);
  if (dropSession.status === "done" && dropSession.startedAt !== syncedDoneAt) {
    setSyncedDoneAt(dropSession.startedAt);
    setText(dropSession.remainingText);
    if (dropSession.token) {
      setMode("token");
      setTokenAddr(dropSession.token);
    } else {
      setMode("usdc");
    }
  }

  // The address currently valid enough to READ metadata for — distinct from `asset` below, which is
  // the authoritative "what will this send actually move" decision. Kept separate so the read query
  // itself doesn't depend on the answer it's trying to produce.
  const tokenCandidate = mode === "token" && isAddress(tokenAddr, { strict: false }) ? (tokenAddr as Address) : null;

  const meta = useReadContracts({
    contracts: tokenCandidate
      ? [
          { address: tokenCandidate, abi: erc20Abi, functionName: "symbol", chainId: chain.id } as const,
          { address: tokenCandidate, abi: erc20Abi, functionName: "decimals", chainId: chain.id } as const,
        ]
      : [],
    query: { enabled: !!tokenCandidate },
  });
  // Distinguishes "still loading" from "the read failed" — either the whole multicall failed (meta.status
  // === "error") or it succeeded but this particular call reverted (meta.data[N].status === "failure").
  // Mirrors how a failed fee read is already handled below: a dedicated message instead of an endless
  // "Reading…" state, and Send stays disabled either way.
  const symbolFailed = tokenCandidate ? meta.status === "error" || meta.data?.[0]?.status === "failure" : false;
  const decimalsFailed = tokenCandidate ? meta.status === "error" || meta.data?.[1]?.status === "failure" : false;
  // A token whose name/symbol can't be read still needs a label somewhere the user can trust — its
  // own address, short-formed, rather than an endless "…" that never resolves. The raw symbol() read
  // is a value the token's own creator fully controls, so it's never shown or stored uncleaned. `null`
  // only while genuinely still loading — a failed read resolves to the fallback label rather than
  // blocking (unlike a failed decimals read, which must block: amounts can't be scaled without it).
  const resolvedSymbol = tokenCandidate
    ? (symbolFailed ? shortAddress(tokenCandidate) : (cleanLabel(meta.data?.[0]?.result as string | undefined, 32) ?? null))
    : null;
  // `null` while a real token's decimals are still loading, or failed — never default to 18 or 6,
  // which would parse and quote every amount at the wrong scale (or as the wrong asset — N8) before
  // the read comes back.
  const resolvedDecimals = tokenCandidate ? ((meta.data?.[1]?.result as number | undefined) ?? null) : null;

  // N8: the single source of truth for what this send will actually move — never "null means
  // native". An empty or still-resolving "Another token" pick is `"unresolved"`, which canSend.ts
  // refuses and useDrop.ts's `send()` can never route to a native send. See asset.ts.
  const asset = resolveDropAsset({ mode, tokenAddr, decimals: resolvedDecimals, symbol: resolvedSymbol });
  const symbol = asset.kind === "token" ? asset.symbol : asset.kind === "native" ? "USDC" : "…";
  // No default decimals for an unresolved token (N8) — mirrors `dropAssetDecimals(asset)` (which
  // asset.test.ts tests directly against `resolveDropAsset`'s output) but computed from the same
  // primitives `asset` itself was built from, rather than by reading a property off `asset`, so the
  // React Compiler can still verify the `useMemo`'s dependency below (it otherwise can't prove a
  // property read off a value returned from an imported function is stable across renders). Needs
  // BOTH resolved, exactly like `resolveDropAsset` does: a real multicall settles both fields
  // together, but a token that resolves decimals while its symbol reads back empty/unusable must
  // still stay unresolved here — never scale amounts at a decimals value `asset` itself wouldn't
  // call "resolved" yet.
  const decimals = mode === "usdc" ? 6 : resolvedDecimals !== null && resolvedSymbol !== null ? resolvedDecimals : null;

  // Deferred so typing into a long list doesn't block on re-parsing it every keystroke. Only ever used for
  // the preview (row count, issues, fee) and for detecting staleness below — never for what gets sent.
  const deferredText = useDeferredValue(text);
  const textIsCurrent = text === deferredText;
  const { rows, issues, total } = useMemo(
    () => (decimals === null ? { rows: [], issues: [], total: 0n } : parseDropList(deferredText, decimals)),
    [deferredText, decimals],
  );
  const totalDisplay = decimals === null ? "" : asset.kind === "token" ? formatUnits(total, asset.decimals) : formatUsdc(unitsToNative(total));
  const batches = Math.ceil(rows.length / BATCH) || 0;
  // Derived, not reset from inside the effect below (which would mean calling setState synchronously
  // during an effect, on every row-count change): a stale quote from a previous, longer list must
  // never be shown — or offered a Retry — once the list is empty.
  const quote = rows.length === 0 ? null : fetchedQuote;

  // Debounced: re-quoting on every keystroke would spam the RPC while the user is still typing rows. An
  // empty list needs no fetch — the fee text below already reads as "no fee" once `rows.length` is 0.
  useEffect(() => {
    if (rows.length === 0) return;
    let cancelled = false;
    const id = setTimeout(() => {
      void quoteTotal(rows.length).then((q) => {
        if (!cancelled) setFetchedQuote(q === null ? "error" : q);
      });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [rows.length, quoteTotal]);

  /** Re-fetches the fee on demand — the Retry control below, for when the debounced read above failed
   * (a dead "Couldn't read the fee." state would otherwise only clear itself if the user happened to
   * edit the list again). */
  const retryFee = () => {
    if (rows.length === 0) return;
    void quoteTotal(rows.length).then((q) => setFetchedQuote(q === null ? "error" : q));
  };

  if (!contracts) return <p className="p-5 text-sm text-muted">{"Drop isn't deployed on this network yet."}</p>;

  const readFile = (file: File | undefined) => {
    if (sessionActive || !file) return;
    if (file.size > MAX_FILE_BYTES) return notify("That file is over 2 MB.", "warn");
    void file.text().then(setText);
  };

  const onTextareaDrop = (e: DragEvent<HTMLTextAreaElement>) => {
    const f = e.dataTransfer.files[0];
    if (f) {
      e.preventDefault();
      readFile(f);
    }
  };

  const onFileInput = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    readFile(f);
  };

  const submit = async () => {
    if (decimals === null) return;
    // The rows that get SENT are never the deferred ones: parsed fresh, synchronously, from exactly what's
    // in the box right now. Otherwise a stale render could hand `send` rows that were already delivered a
    // moment ago (see canSend.ts / the "stale text" guard on the button itself).
    const fresh = parseDropList(text, decimals);
    if (fresh.rows.length === 0) return;
    // Mirrors Mint's own fresh-fee guard: refuse to start a paid send without a known fee to compare
    // against, rather than silently skipping the per-batch staleness check below.
    if (quote === null || quote === "error") return notify("Couldn't read the fee. Try again.", "warn");
    // I1 (wave E): the quote is fetched debounced (300ms after the row count last changed), so a
    // paste that grows the list and a click on Send can land inside that window — the button's own
    // canSend() check below already disables for this, but `submit` is the real guard: `quote.count`
    // (what the fee on screen was computed for) is compared against `fresh.rows.length` (what's about
    // to actually be sent), both read synchronously right now, never the possibly-stale render props.
    if (quote.count !== fresh.rows.length) {
      return notify("The fee shown doesn't match the current list — wait for it to update and try again.", "warn");
    }
    // Rows the parser rejected (bad address, bad amount, a duplicate, ...) never reach `fresh.rows`,
    // so their ORIGINAL TEXT is captured here — the only place that still has it, since a partial
    // send later replaces this textarea with just the unsent remainder — for the result panel to say
    // a send didn't cover them, and show exactly what was excluded and why (session.ts's
    // excludedRows, result.ts's ExcludedRow, ResultPanel.tsx).
    const textLines = text.split(/\r?\n/);
    const excludedRows = fresh.issues.map((i) => ({ line: i.line, text: textLines[i.line - 1] ?? "", reason: i.message }));
    // Only ever "token" or "native" here — `decimals === null` above already returned for
    // "unresolved" (see asset.ts's doc comment / N8).
    const token = asset.kind === "token" ? asset.address : null;
    const started = session.start(token ? symbol : "USDC", token, decimals, text, excludedRows);
    if (!started) return; // a send is already in flight (another click, another window) — do nothing
    setBusy(true);
    try {
      const result = await send(asset, fresh.rows, quote);
      trackEvent("drop_success", { recipients: result.delivered.length, batches: result.hashes.length });
    } catch (err) {
      notify(describeContractError(err), "warn", 6000);
    } finally {
      setBusy(false);
    }
  };

  const copyFailed = async () => {
    if (!dropSession.result || dropSession.decimals === null) return;
    const clip = failedRowsText(dropSession.result.failed, dropSession.token, dropSession.decimals);
    try {
      await navigator.clipboard.writeText(clip);
      notify("Failed rows copied");
    } catch {
      notify("Couldn't copy to the clipboard.", "warn");
    }
  };

  // N1: the unconfirmed section's three controls. Copying/recovering both need the session's own
  // `token`/`decimals` (captured once at `start`) — not this render's `asset`, which describes
  // whatever the form currently holds, not what the unconfirmed batch was actually sent as.
  const copyUnconfirmed = async () => {
    if (!dropSession.result || dropSession.decimals === null) return;
    const clip = formatDropList(dropSession.result.unconfirmed, dropSession.token, dropSession.decimals);
    try {
      await navigator.clipboard.writeText(clip);
      notify("Unconfirmed rows copied");
    } catch {
      notify("Couldn't copy to the clipboard.", "warn");
    }
  };

  const unconfirmedChecked = () => session.dismissUnconfirmed();

  const recoverUnconfirmed = () => {
    if (!dropSession.result || dropSession.decimals === null) return;
    // Appended to THIS window's own local `text` — not re-synced from the session store, which
    // would clobber any edits the user already made to the textarea since the send finished (see
    // the `syncedDoneAt` block above). `session.recoverUnconfirmed()` separately updates the store's
    // own `remainingText`, which is what a freshly reopened window reads on mount.
    const rowsText = formatDropList(dropSession.result.unconfirmed, dropSession.token, dropSession.decimals);
    setText((current) => (current === "" ? rowsText : `${current}\n${rowsText}`));
    session.recoverUnconfirmed();
  };

  const dismissDone = () => {
    session.dismiss();
    setText("");
  };

  // G1: while a sent-but-unconfirmed batch is unresolved, its rows exist only inside this result.
  // Both ways of clearing it — "Done" here and starting the next send — are refused by the session
  // store; the UI reads the same predicate so the controls match what the store will accept.
  const canDismiss = canDismissResult(dropSession.result);

  const decision = canSend({
    busy,
    ready,
    asset,
    tokenAddressEntered: tokenCandidate !== null,
    textIsCurrent,
    rowCount: rows.length,
    issueCount: issues.length,
    sessionActive,
    unconfirmedPending: !canDismiss,
    quoteCount: quote && quote !== "error" ? quote.count : null,
  });

  const progressLabel = !dropSession.progress
    ? `Sending ${dropSession.tokenLabel}…`
    : dropSession.progress.step === "approve"
      ? `Approving ${dropSession.tokenLabel}…`
      : `Sending ${dropSession.tokenLabel} — batch ${dropSession.progress.batch} of ${dropSession.progress.batches}…`;

  const feeText = dropFeeText(quote, rows.length, batches);

  // N2: after an unconfirmed batch, `remaining` alone undercounts — see remainingBannerText's doc
  // comment — so this names both counts rather than reading as if it covers the whole story.
  const banner = dropSession.status === "done" && dropSession.result ? remainingBannerText(dropSession.result) : null;

  return (
    <div className={`flex h-full flex-col text-sm ${over ? "outline outline-2 outline-accent" : ""}`} {...dropProps}>
      <div className="flex items-center gap-2 border-b border-border p-3">
        <div className="inline-flex shrink-0 rounded-md border border-border-2 p-0.5">
          <button
            type="button"
            aria-pressed={mode === "usdc"}
            disabled={sessionActive}
            className={`rounded px-2 py-1 ${mode === "usdc" ? "bg-surface-2" : ""}`}
            onClick={() => setMode("usdc")}
          >
            USDC
          </button>
          <button
            type="button"
            aria-pressed={mode === "token"}
            disabled={sessionActive}
            className={`rounded px-2 py-1 ${mode === "token" ? "bg-surface-2" : ""}`}
            onClick={() => setMode("token")}
          >
            Another token
          </button>
        </div>
        {mode === "token" && (
          <input
            className="min-w-0 flex-1 rounded-md border border-border-2 bg-surface px-2 py-1.5 font-mono text-xs"
            placeholder="Token contract address"
            value={tokenAddr}
            disabled={sessionActive}
            onChange={(e) => setTokenAddr(e.target.value)}
            aria-label="Token address"
          />
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {banner && <p className="mb-2 text-accent-3-text">{banner}</p>}
        <textarea
          className="h-32 w-full rounded-md border border-border-2 bg-surface px-2 py-1.5 font-mono text-xs"
          placeholder={"0x… , 12.5"}
          value={sessionActive ? dropSession.remainingText : text}
          readOnly={sessionActive}
          onChange={(e) => setText(e.target.value)}
          onDrop={onTextareaDrop}
          onDragOver={(e) => e.preventDefault()}
          aria-label="Recipients"
        />
        <label className="mt-2 flex items-center gap-2 text-xs text-muted">
          Choose CSV
          <input type="file" accept=".csv,text/csv,text/plain" className="text-xs" disabled={sessionActive} onChange={onFileInput} />
        </label>

        {sessionActive ? (
          <>
            <p className="mt-3">{progressLabel}</p>
            <p className="mt-1 text-xs text-muted">Keep this tab open until it finishes. You can close this window; the send continues.</p>
          </>
        ) : tokenCandidate && decimalsFailed ? (
          <p className="mt-3 text-accent-3-text">{"Couldn't read this token. Check the address."}</p>
        ) : decimals === null ? (
          <p className="mt-3 text-muted">{tokenCandidate ? "Reading the token…" : "Enter the token's address first."}</p>
        ) : (
          <>
            <p className="mt-3">
              {rows.length} recipients{issues.length > 0 ? ` · ${issues.length} excluded` : ""} · total {totalDisplay} {symbol}
            </p>
            <IssuesList issues={issues} />
            {quote === "error" ? (
              <p className="mt-3 text-xs text-accent-3-text">
                {"Couldn't read the fee. "}
                <button type="button" className="underline" onClick={retryFee}>
                  Retry
                </button>
              </p>
            ) : (
              feeText && <p className="mt-3 text-xs text-muted">{feeText}</p>
            )}
          </>
        )}

        {dropSession.status === "done" && dropSession.result && (
          <>
            <ResultPanel
              result={dropSession.result}
              excludedRows={dropSession.excludedRows}
              onCopyFailed={copyFailed}
              onCopyUnconfirmed={copyUnconfirmed}
              onUnconfirmedChecked={unconfirmedChecked}
              onRecoverUnconfirmed={recoverUnconfirmed}
            />
            {canDismiss && (
              <button type="button" className="mt-2 rounded-md border border-border-2 px-2 py-1" onClick={dismissDone}>
                Done
              </button>
            )}
          </>
        )}
      </div>

      <div className="border-t border-border p-3">
        <button type="button" disabled={!decision.ok} className="w-full rounded-md border border-border-2 px-3 py-2" onClick={submit}>
          {decision.label}
        </button>
      </div>
    </div>
  );
}

export default function DropWindow({ params }: AppProps) {
  return (
    <ConnectGate>
      <Form params={params} />
    </ConnectGate>
  );
}
