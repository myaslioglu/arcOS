type Entry<V> = { at: number; value: Promise<V>; ttlMs: number | null };

/**
 * An in-memory memo with a TTL (inspect-server.ts keeps one per server process). Stores the promise, so concurrent
 * callers share one load. `ttl` is a number of ms, or a function that picks one from the loaded value. Either way it
 * counts from when the load started, and a load still in flight (its TTL isn't known yet) is shared until it settles.
 * A load that rejects is dropped, never cached.
 */
export function ttlCache<V>(ttl: number | ((value: V) => number), max = 500, now: () => number = Date.now) {
  const entries = new Map<string, Entry<V>>();
  return {
    get(key: string, load: () => Promise<V>): Promise<V> {
      const hit = entries.get(key);
      if (hit && (hit.ttlMs === null || now() - hit.at <= hit.ttlMs)) return hit.value;
      const value = load();
      const entry: Entry<V> = { at: now(), value, ttlMs: null };
      entries.delete(key);
      entries.set(key, entry);
      value.then(
        (v) => {
          entry.ttlMs = typeof ttl === "number" ? ttl : ttl(v);
        },
        () => {
          if (entries.get(key) === entry) entries.delete(key);
        },
      );
      if (entries.size > max) entries.delete(entries.keys().next().value as string);
      return value;
    },
  };
}
