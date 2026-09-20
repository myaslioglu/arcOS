type Entry<V> = { at: number; value: Promise<V> };

/** Per-instance memo with a TTL. Stores the promise, so concurrent callers share one load. */
export function ttlCache<V>(ttlMs: number, max = 500, now: () => number = Date.now) {
  const entries = new Map<string, Entry<V>>();
  return {
    get(key: string, load: () => Promise<V>): Promise<V> {
      const hit = entries.get(key);
      if (hit && now() - hit.at <= ttlMs) return hit.value;
      const value = load();
      entries.delete(key);
      entries.set(key, { at: now(), value });
      value.catch(() => {
        if (entries.get(key)?.value === value) entries.delete(key);
      });
      if (entries.size > max) entries.delete(entries.keys().next().value as string);
      return value;
    },
  };
}
