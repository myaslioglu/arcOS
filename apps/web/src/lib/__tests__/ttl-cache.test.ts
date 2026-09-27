import { describe, expect, it, vi } from "vitest";
import { ttlCache } from "../ttl-cache";

describe("ttlCache", () => {
  it("loads once per key within the TTL, again after it", async () => {
    let t = 0;
    const cache = ttlCache<number>(1000, 10, () => t);
    const load = vi.fn(async () => 7);
    expect(await cache.get("a", load)).toBe(7);
    expect(await cache.get("a", load)).toBe(7);
    expect(load).toHaveBeenCalledTimes(1);
    t = 1001;
    await cache.get("a", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight load between concurrent callers", async () => {
    const cache = ttlCache<number>(1000);
    const load = vi.fn(() => new Promise<number>((r) => setTimeout(() => r(1), 5)));
    await Promise.all([cache.get("a", load), cache.get("a", load)]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("doesn't cache failures", async () => {
    const cache = ttlCache<number>(1000);
    await expect(cache.get("a", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await cache.get("a", async () => 2)).toBe(2);
  });

  it("chooses each entry's TTL from the value it loaded, counted from when its load started", async () => {
    let t = 0;
    const cache = ttlCache<{ degraded: boolean }>((v) => (v.degraded ? 30 : 300), 10, () => t);
    let settle: (v: { degraded: boolean }) => void = () => {};
    const degraded = vi.fn(() => new Promise<{ degraded: boolean }>((r) => (settle = r)));
    const clean = vi.fn(async () => ({ degraded: false }));
    const pending = cache.get("d", degraded); // starts at 0...
    await cache.get("c", clean);
    t = 20;
    settle({ degraded: true }); // ...and settles at 20
    await pending;
    t = 30;
    await cache.get("d", degraded);
    await cache.get("c", clean);
    expect([degraded.mock.calls.length, clean.mock.calls.length]).toEqual([1, 1]);
    t = 31; // 31 after the degraded load started, only 11 after it settled: it expires by the start
    degraded.mockImplementation(async () => ({ degraded: true }));
    await cache.get("d", degraded);
    await cache.get("c", clean);
    expect([degraded.mock.calls.length, clean.mock.calls.length]).toEqual([2, 1]);
    t = 301;
    await cache.get("c", clean);
    expect(clean).toHaveBeenCalledTimes(2);
  });

  it("shares a load still in flight, however short a TTL its value will get", async () => {
    let t = 0;
    const cache = ttlCache<number>(() => 1, 10, () => t);
    let release: (v: number) => void = () => {};
    const first = vi.fn(() => new Promise<number>((r) => (release = r)));
    const second = vi.fn(async () => 2);
    const p1 = cache.get("a", first);
    t = 1000;
    const p2 = cache.get("a", second);
    release(1);
    expect([await p1, await p2]).toEqual([1, 1]);
    expect(second).not.toHaveBeenCalled();
  });

  it("evicts the oldest entry past max", async () => {
    const cache = ttlCache<number>(1000, 2);
    const load = vi.fn(async () => 1);
    await cache.get("a", load);
    await cache.get("b", load);
    await cache.get("c", load);
    await cache.get("a", load);
    expect(load).toHaveBeenCalledTimes(4);
  });
});
