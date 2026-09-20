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
