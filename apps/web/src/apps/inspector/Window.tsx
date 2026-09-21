"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { isAddress } from "viem";
import { activeChain, explorerUrl, type Address } from "@arcos/chain";
import { NotAContract, inspect } from "@arcos/inspector";
import { dropParams, useDesktop, useDropTarget, type AppProps } from "@arcos/shell";
import { inspectInput } from "@/lib/inspect-input";
import { trackEvent } from "@/lib/analytics";
import { shortAddress } from "@/lib/format";
import { NAME_DISCLOSURE, passLine } from "@/lib/proof";
import { FindingRow } from "./FindingRow";
import { inspector } from "./manifest";

export default function InspectorWindow({ winId, params }: AppProps) {
  const chain = activeChain();
  const client = usePublicClient({ chainId: chain.id });
  const { open, notify, setTitle } = useDesktop();
  const [draft, setDraft] = useState(params.token ?? "");
  const token = isAddress(params.token ?? "", { strict: false }) ? (params.token as Address) : null;

  const { data: report, error } = useQuery({
    queryKey: ["inspect", chain.id, token?.toLowerCase()],
    enabled: token !== null && client !== undefined,
    staleTime: 5 * 60_000,
    retry: false,
    // trackEvent lives INSIDE queryFn on purpose: queryFn only runs on a genuine network fetch,
    // never on a cache hit — so reopening a window onto an already-cached report never re-fires
    // the analytics event.
    queryFn: async () => {
      const r = await inspect(inspectInput(token!, client!));
      trackEvent("inspect_run", { passed: r.passed, total: r.total });
      return r;
    },
  });

  useEffect(() => {
    if (report) setTitle(winId, `Inspector — ${report.token.symbol ?? shortAddress(report.address)}`);
  }, [report, setTitle, winId]);

  const { over, props: dropProps } = useDropTarget(inspector.acceptsDrop, (item) => open("inspector", dropParams(item)));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const value = draft.trim();
    if (!isAddress(value, { strict: false })) return notify("That isn't an address.", "warn");
    open("inspector", { token: value });
  };

  const share = async () => {
    const url = `${window.location.origin}/t/${report!.address}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      notify("Couldn't copy the link. It's " + url, "warn", 8000);
      return;
    }
    trackEvent("proof_share");
    notify("Proof page link copied");
  };

  const fix = (app: "vault" | "vesting") => {
    trackEvent("fix_click", { app });
    open(app); // coming soon in R0: the shell answers with a toast
  };

  return (
    <div className={`flex h-full flex-col text-sm ${over ? "outline outline-2 outline-accent" : ""}`} {...dropProps}>
      <form onSubmit={submit} className="flex gap-2 border-b border-border p-3">
        <input
          className="min-w-0 flex-1 rounded-md border border-border-2 bg-surface px-2 py-1.5 font-mono text-xs"
          placeholder="0x3600000000000000000000000000000000000000"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label="Token address"
        />
        <button type="submit" className="rounded-md border border-border-2 px-3 py-1.5">Inspect</button>
      </form>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {!token && <p className="text-muted">Paste a token address, or drag a token here from Finder.</p>}
        {token && !report && !error && <p className="text-muted">Reading the contract…</p>}
        {error && (
          <p className="text-accent-3-text">
            {error instanceof NotAContract ? "No contract at that address." : "Couldn't reach the network. Try again."}
          </p>
        )}
        {report && (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-base font-medium">
                  {report.token.name ?? "Unnamed token"} {report.token.symbol ? `· ${report.token.symbol}` : ""}
                </p>
                <a className="font-mono text-xs text-accent-text" href={explorerUrl("token", report.address)} target="_blank" rel="noreferrer">
                  {shortAddress(report.address)}
                </a>
              </div>
              <span className="shrink-0 rounded-md bg-surface-2 px-2 py-1 text-xs">
                {passLine(report)}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted">{NAME_DISCLOSURE}</p>
            {!report.explorerReachable && (
              <p className="mt-2 text-xs text-muted">{"The explorer didn't answer, so some checks are marked unknown."}</p>
            )}
            <ul className="mt-3">
              {report.findings.map((f) => (
                <FindingRow key={f.id} finding={f} onFix={fix} />
              ))}
            </ul>
            <div className="mt-4 flex gap-2">
              <button type="button" className="rounded-md border border-border-2 px-3 py-1.5" onClick={share}>
                Share proof page
              </button>
            </div>
          </>
        )}
      </div>
      <p className="border-t border-border px-4 py-2 text-xs text-faint">Automated analysis, not investment advice.</p>
    </div>
  );
}
