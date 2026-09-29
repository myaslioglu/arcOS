import { afterEach, describe, expect, it, vi } from "vitest";
import { clientKey, inFlightGate, perSecond, rateLimiter, trustedHops } from "../rate-limit";

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

describe("trustedHops", () => {
  it("reads a plain whole number of hops", () => {
    expect(trustedHops("0")).toBe(0);
    expect(trustedHops("1")).toBe(1);
    expect(trustedHops("2")).toBe(2);
    expect(trustedHops("10")).toBe(10);
    expect(trustedHops("  3  ")).toBe(3);
    expect(trustedHops("01")).toBe(1);
  });

  it("reads unset, empty and blank as 0, which is the behaviour before the setting", () => {
    expect(trustedHops(undefined)).toBe(0);
    expect(trustedHops("")).toBe(0);
    expect(trustedHops("   ")).toBe(0);
  });

  it("reads a negative or non-integer value as 0", () => {
    for (const raw of ["-1", "-0", "1.5", "1.0", "0.5", "1e2", "0x1", "+1", "one", "NaN", "Infinity", "1,2", "1 2", "٣", "1n"]) {
      expect(trustedHops(raw), raw).toBe(0);
    }
  });

  it("reads a number too large to be exact as 0", () => {
    expect(trustedHops("99999999999999999999")).toBe(0);
  });

  it("reads the environment's ARCOS_TRUSTED_HOPS when it is not handed a value", () => {
    vi.stubEnv("ARCOS_TRUSTED_HOPS", "2");
    expect(trustedHops()).toBe(2);
    vi.stubEnv("ARCOS_TRUSTED_HOPS", "");
    expect(trustedHops()).toBe(0);
    vi.unstubAllEnvs();
    expect(trustedHops()).toBe(0);
  });
});

describe("clientKey with ARCOS_TRUSTED_HOPS", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const chain = (n: number) => ["203.0.113.1", "198.51.100.2", "192.0.2.3"].slice(0, n).join(", ");
  const key = (entries: number) => clientKey(new Headers({ "x-forwarded-for": chain(entries) }));

  // Leftmost is 203.0.113.1, rightmost of three is 192.0.2.3. n hops skip n entries from the right; a chain of n or fewer entries
  // has no entry the site's own proxies vouch for, and reads as its leftmost.
  it.each([
    // [hops, entries in the header, the key]
    [0, 1, "203.0.113.1"],
    [0, 2, "198.51.100.2"],
    [0, 3, "192.0.2.3"],
    [1, 1, "203.0.113.1"],
    [1, 2, "203.0.113.1"],
    [1, 3, "198.51.100.2"],
    [2, 1, "203.0.113.1"],
    [2, 2, "203.0.113.1"],
    [2, 3, "203.0.113.1"],
  ])("with %i hop(s) reads a header of %i entries as %s", (hops, entries, expected) => {
    vi.stubEnv("ARCOS_TRUSTED_HOPS", String(hops));
    expect(key(entries)).toBe(expected);
  });

  it("is today's key, the rightmost entry, when the setting is unset, empty, negative or not a whole number", () => {
    for (const raw of [undefined, "", "-1", "1.5", "abc"]) {
      if (raw === undefined) vi.unstubAllEnvs();
      else vi.stubEnv("ARCOS_TRUSTED_HOPS", raw);
      expect(key(3), String(raw)).toBe("192.0.2.3");
    }
  });

  it("skips the load balancer's own entry, so two visitors behind it get two buckets", () => {
    const behind = (client: string) => new Headers({ "x-forwarded-for": `${client}, 35.191.0.7` });
    // Unset, both visitors read the load balancer's entry and share one bucket.
    expect(clientKey(behind("203.0.113.10"))).toBe(clientKey(behind("203.0.113.11")));
    vi.stubEnv("ARCOS_TRUSTED_HOPS", "1");
    expect(clientKey(behind("203.0.113.10"))).toBe("203.0.113.10");
    expect(clientKey(behind("203.0.113.11"))).toBe("203.0.113.11");
  });

  it("still ignores what a client wrote to the left of its own address", () => {
    vi.stubEnv("ARCOS_TRUSTED_HOPS", "1");
    const h = new Headers({ "x-forwarded-for": "spoofed-by-client, 203.0.113.10, 35.191.0.7" });
    expect(clientKey(h)).toBe("203.0.113.10");
  });

  // Documents what the setting must never be: above the real number of the site's own proxies, the entry read is one the
  // client wrote, and it can change it on every request to get a bucket of its own.
  it("reads the leftmost entry, which a client wrote, when the setting is higher than the header allows", () => {
    vi.stubEnv("ARCOS_TRUSTED_HOPS", "3");
    const first = clientKey(new Headers({ "x-forwarded-for": "spoof-a, 203.0.113.10, 35.191.0.7" }));
    const second = clientKey(new Headers({ "x-forwarded-for": "spoof-b, 203.0.113.10, 35.191.0.7" }));
    expect(first).toBe("spoof-a");
    expect(second).toBe("spoof-b");
  });

  it("drops empty entries before counting, as it does with no setting", () => {
    vi.stubEnv("ARCOS_TRUSTED_HOPS", "1");
    expect(clientKey(new Headers({ "x-forwarded-for": "203.0.113.10, , 35.191.0.7," }))).toBe("203.0.113.10");
  });

  it("takes the hop's address the same way as the rightmost: trimmed, lowercased, and an IPv6 address by its /64", () => {
    vi.stubEnv("ARCOS_TRUSTED_HOPS", "1");
    const a = clientKey(new Headers({ "x-forwarded-for": "2001:DB8:85A3:1111:AAAA:BBBB:CCCC:DDDD,  35.191.0.7" }));
    const b = clientKey(new Headers({ "x-forwarded-for": "2001:db8:85a3:1111:ffff:1234:5678:9abc, 35.191.0.7" }));
    const c = clientKey(new Headers({ "x-forwarded-for": "2001:db8:85a3:2222::1, 35.191.0.7" }));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toBe("2001:0db8:85a3:1111");
    expect(clientKey(new Headers({ "x-forwarded-for": "  Client.Example  , 35.191.0.7" }))).toBe("client.example");
  });

  it("leaves the Vercel branch alone: on Vercel the platform's own header wins, whatever the setting", () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("ARCOS_TRUSTED_HOPS", "2");
    const h = new Headers({ "x-vercel-forwarded-for": "203.0.113.9", "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3" });
    expect(clientKey(h)).toBe("203.0.113.9");
  });

  it("falls through to x-real-ip and then unknown when there is no chain, whatever the setting", () => {
    vi.stubEnv("ARCOS_TRUSTED_HOPS", "1");
    expect(clientKey(new Headers({ "x-real-ip": "203.0.113.5" }))).toBe("203.0.113.5");
    expect(clientKey(new Headers())).toBe("unknown");
    expect(clientKey(new Headers({ "x-forwarded-for": " , " }))).toBe("unknown");
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
