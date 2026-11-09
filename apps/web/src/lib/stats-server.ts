import "server-only";
import { activeNetwork } from "@arcos/chain";
import { statsAnswer, type StatsAnswer, type StatsDoc } from "@arcos/data";
import { arcosDb, readStats } from "@arcos/data/server";
import { IndexUnavailable, indexEnabled, indexSource } from "./index-source";
import { processGlobal } from "./process-global";

/** The doc is refreshed about every minute and the route is kept 60 s at the CDN: this server reads it at most once a minute. */
const STATS_TTL_MS = 60_000;

// One reader per server process, whichever bundled copy of this module runs (see process-global.ts): one cache, one
// cooldown, its own. It reads the arcos database through the site's own account: one doc, stats/mainnet, one read a fill.
const source = () =>
  processGlobal("index.stats", () =>
    indexSource<StatsDoc | null>({
      load: () => readStats(arcosDb(), "mainnet"),
      ttlMs: STATS_TTL_MS,
      maxKeys: 1,
      unavailableMessage: "The usage counts can't be read right now.",
    }),
  );

/**
 * The public usage counts (statsAnswer: no fee total, no address). Rejects with `IndexUnavailable` when this server
 * doesn't read the index (testnet, a dev server: see `indexEnabled`) or can't right now. Before the indexer has counted
 * anything the answer has no counts.
 */
export async function statsNumbers(): Promise<StatsAnswer> {
  if (!indexEnabled(activeNetwork(), process.env)) throw new IndexUnavailable("This server doesn't read the usage counts.");
  return statsAnswer(await source().get("mainnet"));
}
