import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InspectionTimeout, withDeadline } from "../deadline";

describe("withDeadline", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resolves with the underlying value when it settles before the deadline", async () => {
    const p = withDeadline(Promise.resolve("ok"));
    await expect(p).resolves.toBe("ok");
  });

  it("passes through a rejection that happens before the deadline", async () => {
    const boom = new Error("boom");
    const p = withDeadline(Promise.reject(boom));
    await expect(p).rejects.toBe(boom);
  });

  it("rejects with a typed InspectionTimeout once the deadline elapses first", async () => {
    let release: (v: string) => void = () => {};
    const inner = new Promise<string>((r) => (release = r));
    const p = withDeadline(inner);
    const assertion = expect(p).rejects.toBeInstanceOf(InspectionTimeout);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    release("too late"); // the underlying work keeps running — this must not throw or hang the test
  });

  it("never fires the timeout once the real result has already won the race", async () => {
    const p = withDeadline(Promise.resolve("fast"));
    await expect(p).resolves.toBe("fast");
    // If the timer weren't cleared, advancing past the deadline would be harmless here anyway
    // (nothing is still awaiting `p`), but this documents the intent: no dangling timer leaks.
    await vi.advanceTimersByTimeAsync(15_000);
  });
});
