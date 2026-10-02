import type { PoolDoc, V4PoolKey } from "./docs";

/**
 * The Uniswap v4 pool keys among a token's indexed pools: what the Inspector's `extraPools` takes. The other versions
 * need no key, since the Inspector finds them through their factories. Each key once, in the order given.
 */
export function v4PoolKeys(pools: readonly Pick<PoolDoc, "version" | "key">[]): V4PoolKey[] {
  const seen = new Set<string>();
  const keys: V4PoolKey[] = [];
  for (const pool of pools) {
    if (pool.version !== "v4" || pool.key === null) continue;
    const { currency0, currency1, fee, tickSpacing, hooks } = pool.key;
    const id = [currency0, currency1, fee, tickSpacing, hooks].join(":").toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    keys.push({ currency0, currency1, fee, tickSpacing, hooks });
  }
  return keys;
}
