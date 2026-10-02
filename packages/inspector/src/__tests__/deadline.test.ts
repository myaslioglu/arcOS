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

  it("aborts the work's controller when it gives up, so the work can stop too", async () => {
    const controller = new AbortController();
    const p = withDeadline(new Promise<string>(() => {}), controller);
    const assertion = expect(p).rejects.toBeInstanceOf(InspectionTimeout);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(controller.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(controller.signal.aborted).toBe(true);
  });

  it("leaves the controller alone when the work finishes first", async () => {
    const controller = new AbortController();
    await expect(withDeadline(Promise.resolve("fast"), controller)).resolves.toBe("fast");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(controller.signal.aborted).toBe(false);
  });

  it("clears the deadline timer once the real result has already won the race, leaving nothing pending", async () => {
    const p = withDeadline(Promise.resolve("fast"));
    await expect(p).resolves.toBe("fast");
    expect(vi.getTimerCount()).toBe(0);
  });
});
