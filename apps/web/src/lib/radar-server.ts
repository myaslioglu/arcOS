import "server-only";
import { activeNetwork } from "@arcos/chain";
import { RADAR_FEED_FILTERS, type RadarFeedFilter } from "@arcos/data";
import { arcosDb, readRadarFeed } from "@arcos/data/server";
import { IndexUnavailable, indexEnabled, indexSource } from "./index-source";
import { processGlobal } from "./process-global";
import { radarPage, type RadarPage } from "./radar";

/** Under the 20 s client poll and the 20 s s-maxage, so a page is read at most 4 times a minute per filter. */
const RADAR_TTL_MS = 15_000;

// One reader per server process, whichever bundled copy of this module runs (see process-global.ts): one cache, one
// cooldown, its own and apart from the pools reader. It reads the arcos database through the site's own account
// (arcos-web@, roles/datastore.user on arcos only): one radarFeed doc and indexer/mainnet, 2 reads per fill.
const source = () =>
  processGlobal("index.radar", () =>
    indexSource<RadarPage>({
      load: async (filter) => {
        const page = radarPage(await readRadarFeed(arcosDb(), "mainnet", filter as RadarFeedFilter));
        // A count only: a malformed stored row is the indexer's to fix, and nothing of it belongs in a log line.
        if (page.skipped > 0) console.warn("radar rows skipped", page.skipped);
        return page;
      },
      ttlMs: RADAR_TTL_MS,
      maxKeys: RADAR_FEED_FILTERS.length,
      unavailableMessage: "The token index can't be read right now.",
    }),
  );

/**
 * The first Radar page of `filter`. Rejects with `IndexUnavailable` when this server doesn't read the index (testnet, a
 * dev server: see `indexEnabled`) or can't right now.
 */
export function radarFeedPage(filter: RadarFeedFilter): Promise<RadarPage> {
  if (!indexEnabled(activeNetwork(), process.env)) return Promise.reject(new IndexUnavailable("This server doesn't read the token index."));
  return source().get(filter);
}
