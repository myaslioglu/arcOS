import { afterEach, describe, expect, it, vi } from "vitest";
import { clientKey, inFlightGate, perSecond, rateLimiter } from "../rate-limit";

describe("rateLimiter", () => {
  it("allows `limit` calls then refuses with a positive whole-second retryAfterSec", () => {
    let t = 0;
    const rl = rateLimiter(3, 10_000, undefined, () => t);
    expect(rl.take("a")).toEqual({ ok: true });
    expect(rl.take("a")).toEqual({ ok: true });
    expect(rl.take("a")).toEqual({ ok: true });
    t = 4_200;
    const decision = rl.take("a");
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("unreachable");
    expect(Number.isInteger(decision.retryAfterSec)).toBe(true);
    expect(decision.retryAfterSec).toBeGreaterThan(0);
  });

  it("resets once a new window starts", () => {
    let t = 0;
    const rl = rateLimiter(1, 1000, undefined, () => t);
    expect(rl.take("a").ok).toBe(true);
    expect(rl.take("a").ok).toBe(false);
    t = 1000;
    expect(rl.take("a").ok).toBe(true);
  });

  it("tracks keys independently", () => {
    const rl = rateLimiter(1, 1000, undefined, () => 0);
    expect(rl.take("a").ok).toBe(true);
    expect(rl.take("b").ok).toBe(true);
    expect(rl.take("a").ok).toBe(false);
  });

  it("evicts the oldest key past maxKeys so memory stays bounded", () => {
    const rl = rateLimiter(1, 1000, 2, () => 0);
    expect(rl.take("a").ok).toBe(true);
    expect(rl.take("b").ok).toBe(true);
    expect(rl.take("c").ok).toBe(true); // evicts "a"
    expect(rl.take("a").ok).toBe(true); // "a" was forgotten, so it's allowed again
  });
});

describe("inFlightGate", () => {
  it("runs up to max concurrently, then refuses the next", async () => {
    const gate = inFlightGate(2, () => new Error("busy"));
    let release1: () => void = () => {};
    let release2: () => void = () => {};
    const p1 = gate.run(() => new Promise<void>((r) => (release1 = r)));
    const p2 = gate.run(() => new Promise<void>((r) => (release2 = r)));
    await expect(gate.run(() => Promise.resolve())).rejects.toThrow("busy");
    release1();
    release2();
    await Promise.all([p1, p2]);
  });

  it("frees a slot on success", async () => {
    const gate = inFlightGate(1, () => new Error("busy"));
    await expect(gate.run(() => Promise.resolve("ok"))).resolves.toBe("ok");
    await expect(gate.run(() => Promise.resolve("ok2"))).resolves.toBe("ok2");
  });

  it("frees a slot on failure", async () => {
    const gate = inFlightGate(1, () => new Error("busy"));
    await expect(gate.run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(gate.run(() => Promise.resolve("ok"))).resolves.toBe("ok");
  });
});

describe("clientKey", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers x-vercel-forwarded-for over everything else, when actually running on Vercel", () => {
    vi.stubEnv("VERCEL", "1");
    const h = new Headers({ "x-vercel-forwarded-for": "203.0.113.9", "x-forwarded-for": "1.2.3.4, 5.6.7.8", "x-real-ip": "9.9.9.9" });
    expect(clientKey(h)).toBe("203.0.113.9");
  });

  // Off Vercel (a self-hosted deploy, or a local/dev server) nothing verifies x-vercel-forwarded-for
  // came from the platform — a client could set it on itself just as easily as x-forwarded-for. It
  // must be ignored there and the request must fall through to the rightmost x-forwarded-for hop.
  it("ignores x-vercel-forwarded-for off-platform and falls through to the rightmost x-forwarded-for hop", () => {
    const h = new Headers({ "x-vercel-forwarded-for": "203.0.113.9", "x-forwarded-for": "1.2.3.4, 5.6.7.8", "x-real-ip": "9.9.9.9" });
    expect(clientKey(h)).toBe("5.6.7.8");
  });

  it("uses the RIGHTMOST entry of x-forwarded-for — the hop the nearest trusted proxy added", () => {
    const h = new Headers({ "x-forwarded-for": "client-spoofed, 10.0.0.1, 198.51.100.7" });
    expect(clientKey(h)).toBe("198.51.100.7");
  });

  it("falls back to x-real-ip when there's no forwarded-for chain", () => {
    const h = new Headers({ "x-real-ip": "203.0.113.5" });
    expect(clientKey(h)).toBe("203.0.113.5");
  });

  it("falls back to \"unknown\" when nothing is present", () => {
    expect(clientKey(new Headers())).toBe("unknown");
  });

  it("trims and lowercases", () => {
    const h = new Headers({ "x-real-ip": "  2001:DB8::1  " });
    expect(clientKey(h)).not.toContain(" ");
    expect(clientKey(h)).toBe(clientKey(h).toLowerCase());
  });

  it("collapses an IPv6 address to its /64 prefix, so two addresses in the same block share a key", () => {
    const a = clientKey(new Headers({ "x-real-ip": "2001:db8:85a3:1111:aaaa:bbbb:cccc:dddd" }));
    const b = clientKey(new Headers({ "x-real-ip": "2001:db8:85a3:1111:ffff:1234:5678:9abc" }));
    const c = clientKey(new Headers({ "x-real-ip": "2001:db8:85a3:2222::1" }));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("treats an IPv6 address compressed with \"::\" the same as its expanded form", () => {
    const compressed = clientKey(new Headers({ "x-real-ip": "2001:db8::1" }));
    const expanded = clientKey(new Headers({ "x-real-ip": "2001:db8:0:0:0:0:0:1" }));
    expect(compressed).toBe(expanded);
  });

  it("leaves an IPv4 address alone", () => {
    expect(clientKey(new Headers({ "x-real-ip": "203.0.113.5" }))).toBe("203.0.113.5");
  });
});

describe("perSecond", () => {
  function fakeClock() {
    let t = 0;
    const sleeps: number[] = [];
    return {
      now: () => t,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        t += ms;
      },
      advance: (ms: number) => {
        t += ms;
      },
      sleeps,
    };
  }

  it("starts the first `limit` calls at once", async () => {
    const c = fakeClock();
    const turn = perSecond(4, c.now, c.sleep);
    await Promise.all([turn(), turn(), turn(), turn()]);
    expect(c.sleeps).toEqual([]);
  });

  it("holds the next call until the oldest start in the window is a second old, in arrival order", async () => {
    const c = fakeClock();
    const turn = perSecond(4, c.now, c.sleep);
    const started: [number, number][] = [];
    await Promise.all([0, 1, 2, 3, 4, 5].map((i) => turn().then(() => started.push([i, c.now()]))));
    expect(c.sleeps).toEqual([1000]);
    expect(started).toEqual([[0, 0], [1, 0], [2, 0], [3, 0], [4, 1000], [5, 1000]]);
  });

  it("doesn't wait once the window has passed", async () => {
    const c = fakeClock();
    const turn = perSecond(2, c.now, c.sleep);
    await turn();
    await turn();
    c.advance(1500);
    await turn();
    expect(c.sleeps).toEqual([]);
  });
});
