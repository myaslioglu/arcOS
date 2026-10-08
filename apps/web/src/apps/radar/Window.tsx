"use client";

import { useState } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { activeNetwork } from "@arcos/chain";
import { dragSourceProps, useDesktop } from "@arcos/shell";
import { shortAddress } from "@/lib/format";
import { isGone, radarQueryOptions, type RadarFilters, type RadarItem, type RadarList } from "./feed";
import { ageText, checksText, isStale, liquidityText, sourceLabel, utcText } from "./format";

/** Every control is at least 32px high, 44px on touch. */
const BUTTON = "min-h-8 rounded-md border border-border-2 px-3 text-xs pointer-coarse:min-h-11 disabled:opacity-50";

/** Under every state: what a row's checks are, and what a listing isn't. */
const NOTE =
  "Each token shows the checks Inspector ran on it: evidence, never a score. A listing is not an endorsement. Automated analysis, not investment advice.";

/** Where Radar is: the index holds mainnet data only, so the testnet site points here. */
const MAINNET_RADAR = "https://4rcos.com/#app:radar";

export type RadarView = "elsewhere" | "loading" | "down" | "failed" | "first-run" | "empty" | "no-match" | "list";

type RadarQuery = Pick<UseQueryResult<RadarList, Error>, "isPending" | "isLoadingError" | "isRefetchError" | "error" | "data">;

/**
 * What the window shows, in this order: the site has no index (testnet, or the route answered 404); the first load is
 * under way; it failed with the index down (503) or in any other way; the list is empty because the index hasn't run,
 * because nothing is recorded yet, or because nothing matches the filters; or the list.
 */
export function radarView(mainnet: boolean, query: RadarQuery, filters: RadarFilters): RadarView {
  if (!mainnet || isGone(query.error)) return "elsewhere";
  if (query.isPending) return "loading";
  if (query.isLoadingError) return statusOf(query.error) === 503 ? "down" : "failed";
  const list = query.data;
  if (!list || list.rows.length === 0) {
    if (!list || list.indexedAt === null) return "first-run";
    return filters.liquid || filters.passing ? "no-match" : "empty";
  }
  return "list";
}

const statusOf = (e: unknown): number | null =>
  typeof e === "object" && e !== null && "status" in e && typeof (e as { status: unknown }).status === "number" ? (e as { status: number }).status : null;

/**
 * Radar: the newest tokens the indexer has recorded on Arc mainnet, each with the counts of Inspector's checks, its
 * deepest pool and where the index first saw it, polled every 20 s. A row opens Inspector on a double-click or its
 * Inspect button, and drags as a token file onto Inspector or Drop. Two filters narrow the list to the feeds the
 * indexer keeps. On the testnet site nothing is fetched: it has no index, and the window says so.
 */
export default function RadarWindow() {
  const mainnet = activeNetwork() === "mainnet";
  const { open } = useDesktop();
  const [filters, setFilters] = useState<RadarFilters>({ liquid: false, passing: false });
  const query = useQuery(radarQueryOptions(filters, mainnet));
  const view = radarView(mainnet, query, filters);
  const list = query.data;
  // Every age, the index's too, is measured on the server's clock as the route answered it, never this device's: a
  // device minutes ahead would otherwise call a fresh index stale, and one minutes behind would call a stale one fresh.
  // The ages move with every poll, since each answer carries its own time.
  const now = list?.servedAt ?? 0;

  return (
    <div className="flex h-full flex-col text-sm">
      {mainnet && (
        <div role="group" aria-label="Filters" className="flex flex-wrap gap-x-4 gap-y-1 border-b border-border px-3 py-2">
          <label className="inline-flex min-h-8 items-center gap-2 pointer-coarse:min-h-11">
            <input type="checkbox" checked={filters.liquid} onChange={(e) => setFilters({ ...filters, liquid: e.target.checked })} />
            Has liquidity <span className="text-faint">1,000 USDC or more</span>
          </label>
          <label className="inline-flex min-h-8 items-center gap-2 pointer-coarse:min-h-11">
            <input type="checkbox" checked={filters.passing} onChange={(e) => setFilters({ ...filters, passing: e.target.checked })} />
            At least 5 checks pass
          </label>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {/* Always mounted, so a screen reader hears the text when it arrives: a live region mounted with its text is never announced. */}
        <p className="text-muted" role="status" aria-live="polite">
          {view === "loading" ? "Loading new tokens…" : ""}
        </p>
        {view === "elsewhere" && (
          <div className="grid justify-items-start gap-2">
            <p className="text-muted">Radar lists tokens on Arc mainnet only. This site has no token index.</p>
            <a href={MAINNET_RADAR} className={`${BUTTON} inline-flex items-center`} target="_blank" rel="noopener noreferrer">
              Open Radar on 4rcos.com
            </a>
          </div>
        )}
        {(view === "down" || view === "failed") && (
          <div className="grid justify-items-start gap-2">
            <p className="text-danger-text" role="alert">
              {view === "down"
                ? "The token index can't be read right now. Radar tries again in a minute."
                : "Couldn't load new tokens. Radar tries again in a minute."}
            </p>
            <button type="button" className={BUTTON} onClick={() => void query.refetch()}>
              Try again
            </button>
          </div>
        )}
        {(view === "first-run" || view === "empty" || view === "no-match" || view === "list") && (
          <div className="grid gap-2">
            {query.isRefetchError && !isGone(query.error) && (
              <p className="text-xs text-muted" role="status">
                {"Couldn't refresh the list. Showing the last one."}
              </p>
            )}
            {view !== "first-run" && isStale(list?.indexedAt ?? null, now) && (
              <p className="text-xs text-accent-3-text" role="status">
                {list?.indexedAt == null
                  ? "The index hasn't reported a run yet. New tokens may be missing."
                  : `The index last ran ${ageText(list.indexedAt, now)}. New tokens may be missing.`}
              </p>
            )}
            {view === "first-run" && <p className="text-muted">No tokens recorded yet. The list fills as the index finds new tokens on Arc.</p>}
            {view === "empty" && <p className="text-muted">No tokens recorded yet.</p>}
            {view === "no-match" && <p className="text-muted">No tokens match these filters yet.</p>}
            {view === "list" && list && (
              <>
                <p className="text-xs text-muted">
                  {`Showing the newest ${list.rows.length}.`} Double-click a token to inspect it, or drag it onto Inspector or Drop.
                </p>
                <ul aria-label="New tokens" className="grid gap-2">
                  {list.rows.map((row) => (
                    <Row key={row.address} row={row} now={now} inspect={() => open("inspector", { token: row.address })} />
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>
      <p className="border-t border-border px-3 py-2 text-xs text-faint">{NOTE}</p>
    </div>
  );
}

function Row({ row, now, inspect }: { row: RadarItem; now: number; inspect: () => void }) {
  const symbol = row.symbol ?? "No symbol";
  return (
    <li
      className="grid gap-1 rounded-lg border border-border bg-surface px-3 py-2"
      onDoubleClick={(e) => {
        // The Inspect button opens on its click alone: a double-click on it mustn't open twice.
        if ((e.target as HTMLElement).closest("button")) return;
        inspect();
      }}
      {...(row.decimals !== null ? dragSourceProps({ kind: "token", address: row.address, symbol: row.symbol ?? "", decimals: row.decimals }) : {})}
    >
      <div className="flex items-baseline justify-between gap-2">
        <p className="min-w-0 truncate font-mono" title={row.address}>
          {`${symbol} · ${shortAddress(row.address)}`}
        </p>
        <time dateTime={row.firstSeen} title={utcText(row.firstSeenMs)} className="shrink-0 text-xs text-muted">
          {ageText(row.firstSeenMs, now)}
        </time>
      </div>
      <p className="truncate text-xs text-muted">{row.name ?? "Unnamed token"}</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span>{checksText(row.passed, row.total)}</span>
        <span className="text-muted">{row.bestPoolDepth === null ? "No pool yet" : `Liquidity ${liquidityText(row.bestPoolDepth)}`}</span>
        <span className="rounded border border-border-2 px-1.5 text-faint" title="Where the index first saw it">
          {sourceLabel(row.source)}
        </span>
        {row.launchpad && (
          <span className="rounded border border-border-2 px-1.5 text-accent-text" title={`Launched through ${row.launchpad}`}>
            {row.launchpad}
          </span>
        )}
        <button type="button" className={`${BUTTON} ml-auto`} aria-label={`Inspect ${row.symbol ?? shortAddress(row.address)}`} onClick={inspect}>
          Inspect
        </button>
      </div>
    </li>
  );
}
