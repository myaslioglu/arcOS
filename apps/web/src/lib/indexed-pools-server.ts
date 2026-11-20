import "server-only";
import { activeNetwork, type Address } from "@arcos/chain";
import type { PoolDoc } from "@arcos/data";
import { arcosDb, indexedPoolList, indexedPositionsFor } from "@arcos/data/server";
import {
  IndexUnavailable, extrasFrom, indexEnabled, indexedPoolsSource, indexedPositionsSource, poolsAnswer,
  type IndexedExtras, type IndexedPools, type IndexedToken,
} from "./indexed-pools";
import { processGlobal } from "./process-global";

// One reader of each kind per server process, whichever bundled copy of this module runs (see process-global.ts): one
// cache each, and one cooldown, the pools'. They read the arcos database through the site's own account (arcos-web@,
// roles/datastore.user on arcos only).
const poolsSource = () => processGlobal("index.pools", () => indexedPoolsSource({ load: (token) => indexedPoolList(arcosDb(), "mainnet", token) }));
// The positions of the v4 pools the index lists for the token, and of no other pool: an address the index has no pool
// for costs no positions read at all. Kept apart from the pools, with its own deadline and no cooldown.
const positionsSource = () =>
  processGlobal("index.positions", () =>
    indexedPositionsSource({
      load: async (token) => {
        const { pools } = await poolsSource().pools(token);
        return indexedPositionsFor(arcosDb(), "mainnet", pools.filter((pool) => pool.version === "v4").map((pool) => pool.poolId));
      },
    }),
  );

/**
 * What the index holds for the token on this site's network: its pools, then its v4 pools' positions. Rejects with
 * `IndexUnavailable` when this server doesn't read the index (testnet, a dev server: see `indexEnabled`) or can't read
 * the pools right now. A positions read that fails or takes too long leaves them out (null) and still answers the
 * pools, without arming the pools' cooldown: lp-lock then says what it says without an index.
 */
export async function indexedToken(token: Address, sources: { pools: (token: string) => Promise<IndexedPools>; positions: (token: string) => Promise<IndexedToken["positions"]> } = { pools: (t) => poolsSource().pools(t), positions: (t) => positionsSource().positions(t) }): Promise<IndexedToken> {
  if (!indexEnabled(activeNetwork(), process.env)) throw new IndexUnavailable("This server doesn't read the pool index.");
  const listed = await sources.pools(token);
  try {
    return { ...listed, positions: await sources.positions(token) };
  } catch (e) {
    console.error("positions failed", e instanceof Error ? e.name : "unknown");
    return { ...listed, positions: null };
  }
}

/** The token's indexed pools alone (see `indexedToken`). */
export const indexedPools = async (token: Address): Promise<PoolDoc[]> => (await indexedToken(token)).pools;

/**
 * The Inspector's extras for a token: the index's v4 pools and their positions, or no pools and no positions when the
 * index can't be read. Never rejects.
 */
export async function indexedExtrasFor(token: Address): Promise<IndexedExtras> {
  try {
    const { pools, truncated, positions } = await indexedToken(token);
    return extrasFrom(poolsAnswer(pools, positions, truncated));
  } catch {
    return { extraPools: [] };
  }
}
