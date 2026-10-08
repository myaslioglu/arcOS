import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IndexUnavailable, causeCode, indexSource } from "../index-source";

describe("indexSource", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps an answer for the TTL, per key, and passes the key through as given", async () => {
    const load = vi.fn(async (key: string) => `answer:${key}`);
    let t = 0;
    const source = indexSource({ load, now: () => t, ttlMs: 15_000 });
    await expect(source.get("Liquid")).resolves.toBe("answer:Liquid");
    await expect(source.get("Liquid")).resolves.toBe("answer:Liquid");
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith("Liquid");
    await source.get("all");
    expect(load).toHaveBeenCalledTimes(2);
    t = 15_000;
    await source.get("Liquid");
    expect(load).toHaveBeenCalledTimes(2);
    t = 15_001;
    await source.get("Liquid");
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("gives up on a slow read after the deadline, with the message given, then reads nothing for the cooldown", async () => {
    let t = 0;
    const load = vi.fn(() => new Promise<string>(() => {}));
    const source = indexSource({ load, now: () => t, deadlineMs: 1_500, cooldownMs: 60_000, timeoutMessage: "The index took too long." });
    const slow = source.get("all");
    const settled = expect(slow).rejects.toMatchObject({ name: "IndexUnavailable", message: "The index took too long." });
    t = 1_500;
    await vi.advanceTimersByTimeAsync(1_500);
    await settled;
    await expect(source.get("liquid")).rejects.toBeInstanceOf(IndexUnavailable);
    expect(load).toHaveBeenCalledTimes(1);
    t = 61_499;
    await expect(source.get("liquid")).rejects.toBeInstanceOf(IndexUnavailable);
    expect(load).toHaveBeenCalledTimes(1);
    t = 61_500;
    load.mockResolvedValueOnce("back");
    await expect(source.get("all")).resolves.toBe("back");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("wraps a failed read in IndexUnavailable, keeping the read's own error as the cause for its code", async () => {
    const denied = Object.assign(new Error("7 PERMISSION_DENIED: projects/demo-x/databases/arcos"), { code: 7 });
    const source = indexSource({ load: vi.fn().mockRejectedValue(denied), now: () => 0 });
    const failure = await source.get("all").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(IndexUnavailable);
    expect((failure as Error).message).toBe("The index can't be read right now.");
    expect(causeCode(failure)).toBe(7);
  });

  it("says what the caller named the index, both on a failed read and during the cooldown", async () => {
    let t = 0;
    const load = vi.fn().mockRejectedValueOnce(new Error("UNAVAILABLE")).mockResolvedValue("ok");
    const source = indexSource({ load, now: () => t, cooldownMs: 10, unavailableMessage: "The token index can't be read right now." });
    await expect(source.get("all")).rejects.toMatchObject({ name: "IndexUnavailable", message: "The token index can't be read right now." });
    t = 9;
    await expect(source.get("all")).rejects.toMatchObject({ name: "IndexUnavailable", message: "The token index can't be read right now." });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("never keeps a failure as an answer", async () => {
    let t = 0;
    const load = vi.fn().mockRejectedValueOnce(new Error("UNAVAILABLE")).mockResolvedValue("ok");
    const source = indexSource({ load, now: () => t, cooldownMs: 10 });
    await expect(source.get("all")).rejects.toBeInstanceOf(IndexUnavailable);
    t = 9;
    await expect(source.get("all")).rejects.toBeInstanceOf(IndexUnavailable);
    expect(load).toHaveBeenCalledTimes(1);
    t = 10;
    await expect(source.get("all")).resolves.toBe("ok");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps at most maxKeys answers, dropping the oldest", async () => {
    const load = vi.fn(async (key: string) => key);
    const source = indexSource({ load, now: () => 0, maxKeys: 2 });
    await source.get("a");
    await source.get("b");
    await source.get("c");
    expect(load).toHaveBeenCalledTimes(3);
    await source.get("b");
    await source.get("c");
    expect(load).toHaveBeenCalledTimes(3);
    await source.get("a");
    expect(load).toHaveBeenCalledTimes(4);
  });
});
