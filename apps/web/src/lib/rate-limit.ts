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
 * The rate-limit bucket for a request: `x-vercel-forwarded-for` when present (the platform's own,
 * trusted value); otherwise the RIGHTMOST entry of `x-forwarded-for` — the hop added by the
 * nearest proxy, since every entry to its left is client-supplied and trivially spoofed; then
 * `x-real-ip`; then `"unknown"`. Normalised (trimmed, lowercased) and, for IPv6, collapsed to its
 * /64 prefix so a client cycling through addresses in the same block doesn't dodge the limit.
 * See SECURITY.md for the trusted-proxy assumption this relies on.
 */
export function clientKey(headers: Pick<Headers, "get">): string {
  const vercel = headers.get("x-vercel-forwarded-for")?.trim();
  const forwardedFor = headers.get("x-forwarded-for");
  const rightmost = forwardedFor
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .at(-1);
  const realIp = headers.get("x-real-ip")?.trim();
  const raw = vercel || rightmost || realIp || "unknown";
  const lower = raw.toLowerCase();
  if (lower === "unknown" || lower === "") return "unknown";
  return lower.includes(":") ? ipv6Prefix64(lower) : lower;
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
