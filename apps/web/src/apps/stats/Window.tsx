"use client";

import { useState } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { activeNetwork } from "@arcos/chain";
import { REPO_URL } from "@/lib/site";
import { isGone, statsQueryOptions, type StatsItem, type StatsList } from "./api";
import { CATCHING_UP_BLOCKS, ageText, numberText, sinceText } from "./format";

/** Every control is at least 32px high, 44px on touch. */
const BUTTON = "min-h-8 rounded-md border border-border-2 px-3 text-xs pointer-coarse:min-h-11 disabled:opacity-50";

/** Where Stats is: the counter holds mainnet data only, so the testnet site points here. */
const MAINNET_STATS = "https://4rcos.com/#app:stats";

export type StatsView = "elsewhere" | "loading" | "down" | "failed" | "waiting" | "list";

type StatsQuery = Pick<UseQueryResult<StatsList, Error>, "isPending" | "isLoadingError" | "error" | "data">;

const statusOf = (e: unknown): number | null =>
  typeof e === "object" && e !== null && "status" in e && typeof (e as { status: unknown }).status === "number" ? (e as { status: number }).status : null;

/**
 * What the window shows, in this order: the site keeps no counts (testnet, or the route answered 404); the first load is
 * under way; it failed with the counts unreadable (503) or in any other way; the counter hasn't counted anything yet; or the numbers.
 */
export function statsView(mainnet: boolean, query: StatsQuery): StatsView {
  if (!mainnet || isGone(query.error)) return "elsewhere";
  if (query.isPending) return "loading";
  if (query.isLoadingError) return statusOf(query.error) === 503 ? "down" : "failed";
  if (!query.data || query.data.asOf === null || query.data.items.length === 0) return "waiting";
  return "list";
}

/**
 * Stats: how much ArcOS is used. The numbers anyone can recount on Arc mainnet (each with the date it counts from and a
 * link to the contract's logs), then the ones ArcOS keeps itself, polled every 60 s. On the testnet site nothing is
 * fetched: the counter holds mainnet data only, and the window says so.
 */
export default function StatsWindow() {
  const mainnet = activeNetwork() === "mainnet";
  const query = useQuery(statsQueryOptions(mainnet));
  const view = statsView(mainnet, query);
  const list = query.data;

  return (
    <div className="flex h-full flex-col text-sm">
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {/* Always mounted, so a screen reader hears the text when it arrives: a live region mounted with its text is never announced. */}
        <p className="text-muted" role="status" aria-live="polite">
          {view === "loading" ? "Loading the counts…" : ""}
        </p>
        {view === "elsewhere" && (
          <div className="grid justify-items-start gap-2">
            <p className="text-muted">Stats are kept for Arc mainnet only.</p>
            <a href={MAINNET_STATS} className={`${BUTTON} inline-flex items-center`} target="_blank" rel="noopener noreferrer">
              Open Stats on 4rcos.com
            </a>
          </div>
        )}
        {(view === "down" || view === "failed") && (
          <div className="grid justify-items-start gap-2">
            <p className="text-danger-text" role="alert">
              {view === "down" ? "The usage counts can't be read right now. Stats tries again in a minute." : "Couldn't load the counts. Stats tries again in a minute."}
            </p>
            <button type="button" className={BUTTON} onClick={() => void query.refetch()}>
              Try again
            </button>
          </div>
        )}
        {view === "waiting" && <p className="text-muted">Counting hasn&apos;t started yet. The numbers appear once the index has read the chain.</p>}
        {view === "list" && list && <Numbers list={list} stale={query.isRefetchError} />}
      </div>
    </div>
  );
}

function Numbers({ list, stale }: { list: StatsList; stale: boolean }) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const onchain = list.items.filter((i) => i.source === "onchain");
  const server = list.items.filter((i) => i.source === "server");
  const asOf = list.asOf;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(new URL("/api/stats", window.location.origin).href);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  };

  return (
    <div className="grid gap-4">
      {stale && (
        <p className="text-xs text-muted" role="status">
          {"Couldn't refresh the counts. Showing the last ones."}
        </p>
      )}
      {asOf && asOf.behind > CATCHING_UP_BLOCKS && (
        <p className="text-xs text-accent-3-text" role="status">
          The on-chain counts are still catching up with the chain, so they are lower than the real totals for now.
        </p>
      )}
      {onchain.length > 0 && <Group title="On Arc mainnet, anyone can check" items={onchain} />}
      {server.length > 0 && <Group title="Recorded by ArcOS" items={server} />}
      <footer className="grid gap-2 border-t border-border pt-3 text-xs text-faint">
        <p>
          {asOf ? `As of block ${numberText(asOf.block)} · updated ${ageText(asOf.atMs, list.servedAt)} · ` : ""}automated count
        </p>
        {list.notes.length > 0 && (
          <ul className="grid list-disc gap-1 pl-4">
            {list.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={BUTTON} onClick={() => void copy()}>
            Copy JSON link
          </button>
          {REPO_URL && (
            <a className={`${BUTTON} inline-flex items-center`} href={`${REPO_URL}#how-stats-counts`} target="_blank" rel="noopener noreferrer">
              How these are counted
            </a>
          )}
          <span role="status" aria-live="polite" className="text-muted">
            {copied === "copied" ? "Link copied" : copied === "failed" ? "Couldn't copy the link" : ""}
          </span>
        </div>
      </footer>
    </div>
  );
}

function Group({ title, items }: { title: string; items: StatsItem[] }) {
  return (
    <section aria-label={title} className="grid gap-2">
      <h3 className="text-xs font-medium text-muted">{title}</h3>
      <ul className="grid gap-2">
        {items.map((item) => (
          <Row key={item.id} item={item} />
        ))}
      </ul>
    </section>
  );
}

function Row({ item }: { item: StatsItem }) {
  const since = sinceText(item.since);
  return (
    <li className="grid gap-1 rounded-lg border border-border bg-surface px-3 py-2">
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0">{item.label}</p>
        <p className="shrink-0 text-base font-medium tabular-nums">{numberText(item.value)}</p>
      </div>
      {item.parts.length > 0 && (
        <p className="text-xs text-muted tabular-nums">{item.parts.map((p) => `${p.label} ${numberText(p.value)}`).join(" · ")}</p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-faint">
        {since && <span>{since}</span>}
        {item.links.map((link) => (
          <a key={link.href} className="text-accent-text underline" href={link.href} target="_blank" rel="noopener noreferrer">
            {`${link.label} logs`}
          </a>
        ))}
      </div>
    </li>
  );
}
