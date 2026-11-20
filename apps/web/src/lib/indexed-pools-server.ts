import "server-only";
import { activeNetwork, arcInspectChain, type Address } from "@arcos/chain";
import { v4PoolKeys, type PoolDoc } from "@arcos/data";
import { arcosDb, indexedPools as readIndexedPools, indexedPositionsFor } from "@arcos/data/server";
import { v4PoolIdsToIndex, type ExtraPool } from "@arcos/inspector";
import { IndexUnavailable, extrasFrom, indexEnabled, indexedPoolsSource, poolsAnswer, type IndexedExtras, type IndexedToken } from "./indexed-pools";
import { processGlobal } from "./process-global";

/**
 * A token's pools, then the positions of its v4 pools: the pools the index recorded and the standard hookless keys the
 * Inspector also asks about (`v4PoolIdsToIndex`), one query a pool. A positions read that fails leaves them out (null)
 * and still answers the pools: lp-lock then says what it says without an index, and discovery keeps its extra pools.
 */
async function load(token: string): Promise<IndexedToken> {
  const db = arcosDb();
  const pools = await readIndexedPools(db, "mainnet", token);
  try {
    const { dex, nativeQuote } = arcInspectChain("mainnet");
    const extraPools: ExtraPool[] = v4PoolKeys(pools).map((key) => ({ version: "v4", key }));
    return { pools, positions: await indexedPositionsFor(db, "mainnet", v4PoolIdsToIndex({ address: token as Address, dex, nativeQuote, extraPools })) };
  } catch (e) {
    console.error("positions failed", e instanceof Error ? e.name : "unknown");
    return { pools, positions: null };
  }
}

// One reader per server process, whichever bundled copy of this module runs (see process-global.ts): one cache, one
// cooldown. It reads the arcos database through the site's own account (arcos-web@, roles/datastore.user on arcos only).
const source = () => processGlobal("index.token", () => indexedPoolsSource({ load }));

/**
 * What the index holds for the token on this site's network: its pools and its v4 pools' positions. Rejects with
 * `IndexUnavailable` when this server doesn't read the index (testnet, a dev server: see `indexEnabled`) or can't right now.
 */
export function indexedToken(token: Address): Promise<IndexedToken> {
  if (!indexEnabled(activeNetwork(), process.env)) return Promise.reject(new IndexUnavailable("This server doesn't read the pool index."));
  return source().token(token);
}

/** The token's indexed pools alone (see `indexedToken`). */
export const indexedPools = async (token: Address): Promise<PoolDoc[]> => (await indexedToken(token)).pools;

/**
 * The Inspector's extras for a token: the index's v4 pools and their positions, or no pools and no positions when the
 * index can't be read. Never rejects.
 */
export async function indexedExtrasFor(token: Address): Promise<IndexedExtras> {
  try {
    const { pools, positions } = await indexedToken(token);
    return extrasFrom(poolsAnswer(pools, positions));
  } catch {
    return { extraPools: [] };
  }
}
