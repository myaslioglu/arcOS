"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { isAddress } from "viem";
import { activeChain, activeNetwork, arcInspectChain, chainExplorerUrl, explorerUrl, otherExplorerUrl, type Address } from "@arcos/chain";
import { NotAContract, inspect } from "@arcos/inspector";
import { dropParams, useDesktop, useDropTarget, type AppProps } from "@arcos/shell";
import { fetchIndexedExtras } from "@/lib/indexed-pools";
import { inspectInput } from "@/lib/inspect-input";
import {
  chainName,
  inspectorChain,
  inspectorParams,
  notReadHere,
  pickToken,
  readsOtherChains,
  registryChainBySlug,
  siteChainBySlug,
  siteInspectChains,
} from "@/lib/inspect-chain-pick";
import { trackEvent } from "@/lib/analytics";
import { shortAddress } from "@/lib/format";
import { NAME_DISCLOSURE, passLine, readAtLine } from "@/lib/proof";
import { FindingRow } from "./FindingRow";
import { inspector } from "./manifest";
import { NOT_HERE, ServerReportError, serverReport } from "./server-report";

/** Arc's placeholder, as it always was: its USDC. Another chain's is that chain's USDC. */
const ARC_PLACEHOLDER = "0x3600000000000000000000000000000000000000";

export default function InspectorWindow({ winId, params }: AppProps) {
  const arc = activeChain();
  const client = usePublicClient({ chainId: arc.id });
  const { open, notify, setTitle } = useDesktop();
  // The chain the params name, read as the instance key reads it (inspectorChain): null for one this site doesn't read.
  const chain = inspectorChain(params.chain);
  const offArc = chain !== null && chain.key !== "arc";
  // The chain picker shows only once the site reads a chain besides Arc; until then the window is Arc's, as it always was.
  const choices = readsOtherChains() ? siteInspectChains() : [];
  // A chain the window refuses leaves the input empty: one click on Inspect never reads that address on Arc instead.
  const [draft, setDraft] = useState(chain === null ? "" : (params.token ?? ""));
  const [draftChain, setDraftChain] = useState(chain?.slug ?? "arc");
  const token = chain && isAddress(params.token ?? "", { strict: false }) ? (params.token as Address) : null;

  const { data: report, error } = useQuery({
    // By chain id, so Arc's key is the one it always was and each chain's reports are its own.
    queryKey: ["inspect", chain?.chainId, token?.toLowerCase()],
    enabled: token !== null && chain !== null && (offArc || client !== undefined),
    staleTime: 5 * 60_000,
    retry: false,
    // trackEvent lives INSIDE queryFn on purpose: queryFn only runs on a genuine network fetch,
    // never on a cache hit — so reopening a window onto an already-cached report never re-fires
    // the analytics event.
    queryFn: async (context) => {
      if (offArc) {
        // Another chain is read by this site's server, never from the browser: /api/inspect/<chain>/<address>. Only this
        // branch reads React Query's signal: reading it is what has React Query end the request when the window closes,
        // and Arc's inspection, which never reads it, runs on into the cache as it always has.
        const { signal } = context;
        const r = await serverReport(chain, token!, { signal });
        // An answer that came after the window let the request go is no inspection anyone saw, so it isn't counted.
        if (!signal.aborted) trackEvent("inspect_run", { passed: r.passed, total: r.total, chain: chain.slug });
        return r;
      }
      // The index's pools for the token (hooked v4 pools among them) and its v4 pools' positions, from the site; only
      // mainnet has an index.
      const { extraPools, extraPoolsTruncated, v4Positions } = activeNetwork() === "mainnet" ? await fetchIndexedExtras(token!) : { extraPools: [] };
      const r = await inspect(inspectInput(token!, client!, undefined, undefined, extraPools, undefined, v4Positions, extraPoolsTruncated));
      trackEvent("inspect_run", { passed: r.passed, total: r.total, chain: "arc" });
      return r;
    },
  });

  useEffect(() => {
    if (!report) return;
    const label = report.token.symbol ?? shortAddress(report.address);
    setTitle(winId, offArc && chain ? `Inspector — ${label} - ${chainName(chain)}` : `Inspector — ${label}`);
  }, [report, setTitle, winId, offArc, chain]);

  const { over, props: dropProps } = useDropTarget(inspector.acceptsDrop, (item) => open("inspector", dropParams(item)));

  /** A pasted link or `<chain>:0x…` fills the address and picks its chain, where the site reads it. */
  const edit = (value: string) => {
    if (choices.length > 0) {
      const picked = pickToken(value);
      if (picked.kind === "token" && picked.chain && value.trim() !== picked.address) {
        setDraftChain(picked.chain.slug);
        setDraft(picked.address);
        return;
      }
    }
    setDraft(value);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const value = draft.trim();
    if (choices.length === 0) {
      if (!isAddress(value, { strict: false })) return notify("That isn't an address.", "warn");
      return open("inspector", { token: value });
    }
    const picked = pickToken(value);
    if (picked.kind === "elsewhere") return notify(notReadHere(picked.name), "warn");
    if (picked.kind === "none") return notify("That isn't an address.", "warn");
    const target = picked.chain ?? siteChainBySlug(draftChain) ?? arcInspectChain(activeNetwork());
    // A bare address keeps what was typed, as it always has; a link gives the address it names.
    open("inspector", inspectorParams(target, picked.chain ? picked.address : value));
  };

  const share = async () => {
    const path = offArc && chain ? `/t/${chain.slug}/${report!.address}` : `/t/${report!.address}`;
    const url = `${window.location.origin}${path}`;
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
    open(app); // both are grey apps: the shell opens their work-in-progress window
  };

  const picked = choices.find((c) => c.slug === draftChain);
  const placeholder = picked && picked.key !== "arc" ? (picked.dex?.quoteTokens[0]?.address ?? ARC_PLACEHOLDER) : ARC_PLACEHOLDER;
  const errorText =
    error instanceof ServerReportError ? error.message : error instanceof NotAContract ? "No contract at that address." : "Couldn't reach the network. Try again.";
  // A slug in the params that names no chain this site reads: said by name when the registry knows it, never echoed.
  const unknownChain = chain === null ? registryChainBySlug(params.chain ?? "") : null;

  return (
    <div className={`flex h-full flex-col text-sm ${over ? "outline outline-2 outline-accent" : ""}`} {...dropProps}>
      <form onSubmit={submit} className="flex gap-2 border-b border-border p-3">
        {choices.length > 0 && (
          <select
            className="rounded-md border border-border-2 bg-surface px-2 py-1.5 text-xs"
            value={draftChain}
            onChange={(e) => setDraftChain(e.target.value)}
            aria-label="Chain"
          >
            {choices.map((c) => (
              <option key={c.key} value={c.slug}>
                {chainName(c)}
              </option>
            ))}
          </select>
        )}
        <input
          className="min-w-0 flex-1 rounded-md border border-border-2 bg-surface px-2 py-1.5 font-mono text-xs"
          placeholder={placeholder}
          value={draft}
          onChange={(e) => edit(e.target.value)}
          aria-label="Token address"
        />
        <button type="submit" className="rounded-md border border-border-2 px-3 py-1.5">Inspect</button>
      </form>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {chain === null && <p className="text-accent-3-text">{unknownChain ? notReadHere(chainName(unknownChain)) : NOT_HERE}</p>}
        {chain !== null && !token && <p className="text-muted">Paste a token address, or drag a token here from Finder.</p>}
        {token && !report && !error && <p className="text-muted">{offArc ? "Asking the ArcOS server…" : "Reading the contract…"}</p>}
        {error && <p className="text-accent-3-text">{errorText}</p>}
        {report && chain && (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-base font-medium">
                  {report.token.name ?? "Unnamed token"} {report.token.symbol ? `· ${report.token.symbol}` : ""}
                </p>
                <a
                  className="font-mono text-xs text-accent-text"
                  href={offArc ? chainExplorerUrl(chain, "token", report.address) : explorerUrl("token", report.address)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {shortAddress(report.address)}
                </a>
                {/* Off Arc: the chain's name, and its best-known explorer under the address (a link, never evidence). */}
                {offArc && (
                  <p className="text-xs text-muted">
                    {chainName(chain)}
                    {chain.otherExplorer && (
                      <>
                        {" · "}
                        <a className="text-accent-text" href={otherExplorerUrl(chain, "token", report.address)!} target="_blank" rel="noreferrer">
                          {`Open on ${chain.otherExplorer.name}`}
                        </a>
                      </>
                    )}
                  </p>
                )}
              </div>
              <span className="shrink-0 rounded-md bg-surface-2 px-2 py-1 text-xs">
                {passLine(report)}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted">{NAME_DISCLOSURE}</p>
            {report.explorerSkipped ? (
              <p className="mt-2 text-xs text-muted">{`${report.explorerSkipped} Some checks are marked unknown.`}</p>
            ) : (
              !report.explorerReachable && (
                <p className="mt-2 text-xs text-muted">{"The explorer didn't answer, so some checks are marked unknown."}</p>
              )
            )}
            <ul className="mt-3">
              {report.findings.map((f) => (
                <FindingRow key={f.id} finding={f} onFix={fix} showFix={!offArc} />
              ))}
            </ul>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" className="rounded-md border border-border-2 px-3 py-1.5" onClick={share}>
                Share proof page
              </button>
              {/* Watches are on Arc mainnet only (the index the alerts come from holds mainnet data), so the testnet site
                  has no button, and neither has a report of another chain. */}
              {activeNetwork() === "mainnet" && !offArc && (
                <button
                  type="button"
                  className="rounded-md border border-border-2 px-3 py-1.5"
                  onClick={() => {
                    trackEvent("watch_click");
                    open("watchdog", { token: report.address });
                  }}
                >
                  Watch with Watchdog
                </button>
              )}
            </div>
          </>
        )}
      </div>
      {/* The investment disclaimer is fixed wording (see the global constraints) — the second
          sentence mirrors one line of the README's "What Inspector can and can't see", so the
          limit is stated where the findings are read, not only in the repo. Another chain's report
          is the site's server's, which may have read it minutes before (from its own cache, then
          the CDN's), so the last sentences say who read it and when, as the proof page does. */}
      <p className="border-t border-border px-4 py-2 text-xs text-faint">
        {"Automated analysis, not investment advice. Upgradeable contracts, and code Inspector can't read, are never reported as clean."}
        {offArc && report && ` Read by the ArcOS server. ${readAtLine(report)}.`}
      </p>
    </div>
  );
}
