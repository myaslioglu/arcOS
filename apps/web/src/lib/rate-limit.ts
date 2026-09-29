export type RateDecision = { ok: true } | { ok: false; retryAfterSec: number };

type Window = { start: number; count: number };

/** Fixed-window counter per key. Per server instance — a first line of defence, not a guarantee. */
export function rateLimiter(limit: number, windowMs: number, maxKeys = 5000, now: () => number = Date.now) {
  const windows = new Map<string, Window>();
  return {
    take(key: string): RateDecision {
      const t = now();
      const current = windows.get(key);
      if (!current || t - current.start >= windowMs) {
        windows.delete(key);
        windows.set(key, { start: t, count: 1 });
        if (windows.size > maxKeys) windows.delete(windows.keys().next().value as string);
        return { ok: true };
      }
      if (current.count < limit) {
        current.count += 1;
        return { ok: true };
      }
      const retryAfterSec = Math.max(1, Math.ceil((current.start + windowMs - t) / 1000));
      return { ok: false, retryAfterSec };
    },
  };
}

/** The first 4 groups (64 bits) of an IPv6 address, as a stable string key — enough to bucket a
 * /64, without pulling in a full IPv6 parser. Missing groups (from "::" compression) count as 0. */
function ipv6Prefix64(addr: string): string {
  const noZone = addr.split("%")[0]!;
  const [before] = noZone.split("::");
  const pre = (before ?? "").split(":").filter(Boolean);
  const first4 = pre.length >= 4 ? pre.slice(0, 4) : [...pre, ...Array<string>(4 - pre.length).fill("0")];
  return first4.map((g) => g.padStart(4, "0")).join(":");
}

/**
 * How many entries at the right of `x-forwarded-for` belong to the site's own proxies, from the server-only
 * `ARCOS_TRUSTED_HOPS`. Unset, empty, negative and non-integer all read as 0, which is the behaviour from before the
 * setting: the rightmost entry is the client's. Only plain digits count, so "1.5", "-1", "+1" and "1e2" are 0 too,
 * and so is a number too large to be exact.
 */
export function trustedHops(raw: string | undefined = process.env.ARCOS_TRUSTED_HOPS): number {
  const text = raw?.trim();
  if (!text || !/^\d+$/.test(text)) return 0;
  const hops = Number(text);
  return Number.isSafeInteger(hops) ? hops : 0;
}

/**
 * The rate-limit bucket for a request: `x-vercel-forwarded-for` when present AND this process is
 * actually running on Vercel (`process.env.VERCEL === "1"` — set by the platform itself, never by
 * a request); otherwise the entry of `x-forwarded-for` the site's own proxies vouch for — the
 * RIGHTMOST one, or, with `ARCOS_TRUSTED_HOPS` set to n, the one n places to its left, since every
 * entry to the left of the nearest proxy's is client-supplied and trivially spoofed; then
 * `x-real-ip`; then `"unknown"`. Off Vercel, nothing distinguishes a genuine `x-vercel-forwarded-for`
 * from one a client set on itself, so it's ignored there rather than trusted. Normalised (trimmed,
 * lowercased) and, for IPv6, collapsed to its /64 prefix so a client cycling through addresses in
 * the same block doesn't dodge the limit. See SECURITY.md for the trusted-proxy assumption this
 * relies on.
 *
 * The setting is for a load balancer that adds its own entry to the right of the client's, which
 * would otherwise give every visitor the same key. It must not be higher than the number of proxies
 * the site really has: past that, the entry read is one the client wrote, once it adds entries of
 * its own to the header. That number must also be the same for every address the backend answers on
 * (the site's domain and the platform's default one), since one value can't be right for two.
 * A header too short for the setting isn't read that way: see below.
 */
export function clientKey(headers: Pick<Headers, "get">, hops: number = trustedHops()): string {
  const vercel = process.env.VERCEL === "1" ? headers.get("x-vercel-forwarded-for")?.trim() : undefined;
  const entries =
    headers
      .get("x-forwarded-for")
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? [];
  // A header of `hops` entries or fewer can't hold one for each of the site's proxies and one for the client, so no entry in
  // it is vouched for, and the rightmost is read: the key without the setting, so the setting is never looser than that, for
  // any value. The leftmost would be looser: it is the entry a client writes, and the rightmost is the nearest proxy's.
  const forwarded = entries.length > hops ? entries[entries.length - 1 - hops] : entries.at(-1);
  const realIp = headers.get("x-real-ip")?.trim();
  const raw = vercel || forwarded || realIp || "unknown";
  const lower = raw.toLowerCase();
  if (lower === "unknown" || lower === "") return "unknown";
  return lower.includes(":") ? ipv6Prefix64(lower) : lower;
}

/**
 * Spaces calls out per process: at most `limit` start in any one-second window, in arrival order.
 * `await turn()` before each call. Unlike `rateLimiter`, nothing is refused; later calls wait.
 */
export function perSecond(
  limit: number,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): () => Promise<void> {
  const starts: number[] = [];
  let queue: Promise<void> = Promise.resolve();
  return () => {
    const turn = queue.then(async () => {
      if (starts.length >= limit) {
        const wait = starts[0]! + 1000 - now();
        if (wait > 0) await sleep(wait);
        starts.shift();
      }
      starts.push(now());
    });
    queue = turn;
    return turn;
  };
}

/**
 * Bounds concurrent work per process. `run` throws the caller-supplied error once `max` calls
 * are already in flight; the slot frees in `finally` whether the call succeeds or fails.
 */
export function inFlightGate(max: number, makeError: () => Error) {
  let count = 0;
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (count >= max) throw makeError();
      count += 1;
      try {
        return await fn();
      } finally {
        count -= 1;
      }
    },
  };
}
