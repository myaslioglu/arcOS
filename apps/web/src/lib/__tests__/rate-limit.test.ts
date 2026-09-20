import { describe, expect, it } from "vitest";
import { inFlightGate, rateLimiter } from "../rate-limit";

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
