"use client";

import { useDeferredValue, useEffect, useMemo, useState, useSyncExternalStore, type ChangeEvent, type DragEvent } from "react";
import { useReadContracts } from "wagmi";
import { erc20Abi, formatUnits, isAddress } from "viem";
import { ARCOS, USDC, activeChain, activeNetwork, formatUsdc, unitsToNative, type Address } from "@arcos/chain";
import { dropParams, useDesktop, useDropTarget, type AppProps } from "@arcos/shell";
import { ConnectGate } from "@/components/ConnectGate";
import { describeContractError } from "@/lib/contract-error";
import { trackEvent } from "@/lib/analytics";
import { canSend } from "./canSend";
import { failedRowsText } from "./clipboard";
import { IssuesList } from "./IssuesList";
import { drop } from "./manifest";
import { BATCH, parseDropList } from "./parse";
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

  const token = mode === "token" && isAddress(tokenAddr, { strict: false }) ? (tokenAddr as Address) : null;

  const meta = useReadContracts({
    contracts: token
      ? [
          { address: token, abi: erc20Abi, functionName: "symbol", chainId: chain.id } as const,
          { address: token, abi: erc20Abi, functionName: "decimals", chainId: chain.id } as const,
        ]
      : [],
    query: { enabled: !!token },
  });
  const symbol = token ? ((meta.data?.[0]?.result as string | undefined) ?? "…") : "USDC";
  // Distinguishes "still loading" from "the read failed" — either the whole multicall failed (meta.status
  // === "error") or it succeeded but this particular call reverted (meta.data[1].status === "failure").
  // Mirrors how a failed fee read is already handled below: a dedicated message instead of an endless
  // "Reading…" state, and Send stays disabled either way.
  const decimalsFailed = token ? meta.status === "error" || meta.data?.[1]?.status === "failure" : false;
  // `null` while a real token's decimals are still loading, or failed — never default to 18, which would
  // parse and quote every amount at the wrong scale until the read comes back.
  const decimals = token ? ((meta.data?.[1]?.result as number | undefined) ?? null) : 6;

  // Deferred so typing into a long list doesn't block on re-parsing it every keystroke. Only ever used for
  // the preview (row count, issues, fee) and for detecting staleness below — never for what gets sent.
  const deferredText = useDeferredValue(text);
  const textIsCurrent = text === deferredText;
  const { rows, issues, total } = useMemo(
    () => (decimals === null ? { rows: [], issues: [], total: 0n } : parseDropList(deferredText, decimals)),
    [deferredText, decimals],
  );
  const totalDisplay = decimals === null ? "" : token ? formatUnits(total, decimals) : formatUsdc(unitsToNative(total));
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
    const started = session.start(token ? symbol : "USDC", token, decimals, text);
    if (!started) return; // a send is already in flight (another click, another window) — do nothing
    setBusy(true);
    try {
      const result = await send(token, fresh.rows, decimals, quote.basis);
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

  const dismissDone = () => {
    session.dismiss();
    setText("");
  };

  const decision = canSend({
    busy,
    ready,
    decimalsKnown: decimals !== null,
    textIsCurrent,
    rowCount: rows.length,
    issueCount: issues.length,
    sessionActive,
  });

  const progressLabel = !dropSession.progress
    ? `Sending ${dropSession.tokenLabel}…`
    : dropSession.progress.step === "approve"
      ? `Approving ${dropSession.tokenLabel}…`
      : `Sending ${dropSession.tokenLabel} — batch ${dropSession.progress.batch} of ${dropSession.progress.batches}…`;

  const feeText =
    quote && quote !== "error" && rows.length > 0
      ? `Fee ${formatUsdc(quote.total)} USDC · charged per recipient, including transfers that fail · ${batches} transaction(s)`
      : rows.length > 0
        ? "Reading the fee…"
        : "";

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
            placeholder="0x3600000000000000000000000000000000000000"
            value={tokenAddr}
            disabled={sessionActive}
            onChange={(e) => setTokenAddr(e.target.value)}
            aria-label="Token address"
          />
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {dropSession.status === "done" && dropSession.result && dropSession.result.remaining.length > 0 && (
          <p className="mb-2 text-accent-3-text">
            {`${dropSession.result.remaining.length} rows weren't sent. They're in the list below — check and send again.`}
          </p>
        )}
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
        ) : token && decimalsFailed ? (
          <p className="mt-3 text-accent-3-text">{"Couldn't read this token. Check the address."}</p>
        ) : decimals === null ? (
          <p className="mt-3 text-muted">Reading the token…</p>
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
            <ResultPanel result={dropSession.result} onCopyFailed={copyFailed} />
            <button type="button" className="mt-2 rounded-md border border-border-2 px-2 py-1" onClick={dismissDone}>
              Done
            </button>
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
