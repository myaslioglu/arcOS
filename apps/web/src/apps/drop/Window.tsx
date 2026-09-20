"use client";

import { useDeferredValue, useEffect, useMemo, useState, type ChangeEvent, type DragEvent } from "react";
import { useReadContracts } from "wagmi";
import { erc20Abi, formatUnits, isAddress } from "viem";
import { ARCOS, USDC, activeChain, activeNetwork, formatUsdc, unitsToNative, type Address } from "@arcos/chain";
import { dropParams, useDesktop, useDropTarget, type AppProps } from "@arcos/shell";
import { ConnectGate } from "@/components/ConnectGate";
import { trackEvent } from "@/lib/analytics";
import { failedRowsText } from "./clipboard";
import { IssuesList } from "./IssuesList";
import { BATCH, formatDropList, parseDropList } from "./parse";
import { ResultPanel } from "./ResultPanel";
import { useDrop, type DropResult } from "./useDrop";

const MAX_FILE_BYTES = 2_000_000;
const isUsdc = (addr: string) => addr.toLowerCase() === USDC.toLowerCase();

type Mode = "usdc" | "token";
type Sent = { result: DropResult; token: Address | null; decimals: number };

function Form({ params }: Pick<AppProps, "params">) {
  const chain = activeChain();
  const contracts = ARCOS[activeNetwork()];
  const { open, notify } = useDesktop();
  const { ready, progress, quoteTotal, send } = useDrop();

  const prefilled = isAddress(params.token ?? "", { strict: false }) ? (params.token as Address) : null;
  const [mode, setMode] = useState<Mode>(prefilled && !isUsdc(prefilled) ? "token" : "usdc");
  const [tokenAddr, setTokenAddr] = useState(prefilled && !isUsdc(prefilled) ? prefilled : "");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<Sent | null>(null);
  const [fee, setFee] = useState<bigint | "error" | null>(null);

  const { over, props: dropProps } = useDropTarget(["token"], (item) => open("drop", dropParams(item)));

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
  // `null` while a real token's decimals are still loading (or haven't resolved) — never default to 18,
  // which would parse and quote every amount at the wrong scale until the read comes back.
  const decimals = token ? ((meta.data?.[1]?.result as number | undefined) ?? null) : 6;

  // Deferred so typing into a long list doesn't block on re-parsing it every keystroke.
  const deferredText = useDeferredValue(text);
  const { rows, issues, total } = useMemo(
    () => (decimals === null ? { rows: [], issues: [], total: 0n } : parseDropList(deferredText, decimals)),
    [deferredText, decimals],
  );
  const totalDisplay = decimals === null ? "" : token ? formatUnits(total, decimals) : formatUsdc(unitsToNative(total));
  const batches = Math.ceil(rows.length / BATCH) || 0;

  // Debounced: re-quoting on every keystroke would spam the RPC while the user is still typing rows. An
  // empty list needs no fetch — the fee text below already reads as "no fee" once `rows.length` is 0.
  useEffect(() => {
    if (rows.length === 0) return;
    let cancelled = false;
    const id = setTimeout(() => {
      void quoteTotal(rows.length).then((f) => {
        if (!cancelled) setFee(f === null ? "error" : f);
      });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [rows.length, quoteTotal]);

  if (!contracts) return <p className="p-5 text-sm text-muted">{"Drop isn't deployed on this network yet."}</p>;

  const readFile = (file: File | undefined) => {
    if (!file) return;
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
    setBusy(true);
    setSent(null);
    try {
      const result = await send(token, rows);
      setSent({ result, token, decimals });
      // Rows that landed must never still be in the list — otherwise pressing Send again would send them a
      // second time. Only what's left in `remaining` (never attempted, or whose batch reverted/was refused)
      // goes back into the list; if nothing remains, the list is cleared and Send disables itself.
      setText(result.remaining.length > 0 ? formatDropList(result.remaining, token, decimals) : "");
      trackEvent("drop_success", { recipients: result.delivered.length, batches: result.hashes.length });
    } catch (err) {
      const message = (err as { shortMessage?: string }).shortMessage ?? (err instanceof Error ? err.message : undefined);
      notify(message ?? "The transaction didn't go through.", "warn", 6000);
    } finally {
      setBusy(false);
    }
  };

  const copyFailed = async () => {
    if (!sent) return;
    const clip = failedRowsText(sent.result.failed, sent.token, sent.decimals);
    try {
      await navigator.clipboard.writeText(clip);
      notify("Failed rows copied");
    } catch {
      notify("Couldn't copy to the clipboard.", "warn");
    }
  };

  const sendLabel = busy
    ? progress?.step === "approve"
      ? "Approving…"
      : progress
        ? `Sending batch ${progress.batch} of ${progress.batches}…`
        : "Sending…"
    : `Send to ${rows.length} wallets`;

  const feeText =
    fee === "error"
      ? "Couldn't read the fee. Try again."
      : fee !== null && rows.length > 0
        ? `Fee ${formatUsdc(fee)} USDC · charged per recipient, including transfers that fail · ${batches} transaction(s)`
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
            className={`rounded px-2 py-1 ${mode === "usdc" ? "bg-surface-2" : ""}`}
            onClick={() => setMode("usdc")}
          >
            USDC
          </button>
          <button
            type="button"
            aria-pressed={mode === "token"}
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
            onChange={(e) => setTokenAddr(e.target.value)}
            aria-label="Token address"
          />
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {sent && sent.result.remaining.length > 0 && (
          <p className="mb-2 text-accent-3-text">
            {`${sent.result.remaining.length} rows weren't sent. They're in the list below — check and send again.`}
          </p>
        )}
        <textarea
          className="h-32 w-full rounded-md border border-border-2 bg-surface px-2 py-1.5 font-mono text-xs"
          placeholder={"0x… , 12.5"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onDrop={onTextareaDrop}
          onDragOver={(e) => e.preventDefault()}
          aria-label="Recipients"
        />
        <label className="mt-2 flex items-center gap-2 text-xs text-muted">
          Choose CSV
          <input type="file" accept=".csv,text/csv,text/plain" className="text-xs" onChange={onFileInput} />
        </label>

        {decimals === null ? (
          <p className="mt-3 text-muted">Reading the token…</p>
        ) : (
          <>
            <p className="mt-3">
              {rows.length} recipients · total {totalDisplay} {symbol}
            </p>
            <IssuesList issues={issues} />
            <p className="mt-3 text-xs text-muted">{feeText}</p>
          </>
        )}

        {sent && <ResultPanel result={sent.result} onCopyFailed={copyFailed} />}
      </div>

      <div className="border-t border-border p-3">
        <button
          type="button"
          disabled={rows.length === 0 || !ready || busy || decimals === null}
          className="w-full rounded-md border border-border-2 px-3 py-2"
          onClick={submit}
        >
          {sendLabel}
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
