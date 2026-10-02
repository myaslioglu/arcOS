import "server-only";
import { activeNetwork, type Address } from "@arcos/chain";
import type { PoolDoc } from "@arcos/data";
import { arcosDb, indexedPools as readIndexedPools } from "@arcos/data/server";
import type { ExtraPool } from "@arcos/inspector";
import { IndexUnavailable, extraPoolsFrom, indexEnabled, indexedPoolsSource, poolsAnswer } from "./indexed-pools";
import { processGlobal } from "./process-global";

// One reader per server process, whichever bundled copy of this module runs (see process-global.ts): one cache, one
// cooldown. It reads the arcos database through the site's own account (arcos-web@, roles/datastore.user on arcos only).
const source = () =>
  processGlobal("index.pools", () => indexedPoolsSource({ load: (token) => readIndexedPools(arcosDb(), "mainnet", token) }));

/**
 * The token's indexed pools on this site's network. Rejects with `IndexUnavailable` when this server doesn't read the
 * index (testnet, a dev server: see `indexEnabled`) or can't right now.
 */
export function indexedPools(token: Address): Promise<PoolDoc[]> {
  if (!indexEnabled(activeNetwork(), process.env)) return Promise.reject(new IndexUnavailable("This server doesn't read the pool index."));
  return source().pools(token);
}

/** The Inspector's `extraPools` for a token: the index's v4 pools, or none when the index can't be read. Never rejects. */
export async function extraPoolsFor(token: Address): Promise<ExtraPool[]> {
  try {
    return extraPoolsFrom(poolsAnswer(await indexedPools(token)));
  } catch {
    return [];
  }
}
