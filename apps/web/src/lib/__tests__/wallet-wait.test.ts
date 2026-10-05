import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WALLET_WAIT_NOTICE_MS, scheduleWaitNotice } from "../wallet-wait";

describe("scheduleWaitNotice", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits between 60 and 90 seconds by default", () => {
    expect(WALLET_WAIT_NOTICE_MS).toBeGreaterThanOrEqual(60_000);
    expect(WALLET_WAIT_NOTICE_MS).toBeLessThanOrEqual(90_000);
  });

  it("fires once the wait has passed since the start, not before", () => {
    const onDue = vi.fn();
    scheduleWaitNotice(Date.now(), onDue);
    vi.advanceTimersByTime(WALLET_WAIT_NOTICE_MS - 1);
    expect(onDue).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDue).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(WALLET_WAIT_NOTICE_MS * 2);
    expect(onDue).toHaveBeenCalledTimes(1);
  });

  it("counts from the run's start: a window reopened partway through waits only the rest", () => {
    const onDue = vi.fn();
    scheduleWaitNotice(Date.now() - 50_000, onDue, 75_000);
    vi.advanceTimersByTime(24_999);
    expect(onDue).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDue).toHaveBeenCalledTimes(1);
  });

  it("fires on the next tick, not synchronously, when the wait is already over", () => {
    const onDue = vi.fn();
    scheduleWaitNotice(Date.now() - 10 * 60_000, onDue);
    expect(onDue).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(onDue).toHaveBeenCalledTimes(1);
  });

  it("never fires once cancelled", () => {
    const onDue = vi.fn();
    const cancel = scheduleWaitNotice(Date.now(), onDue);
    vi.advanceTimersByTime(WALLET_WAIT_NOTICE_MS / 2);
    cancel();
    vi.advanceTimersByTime(WALLET_WAIT_NOTICE_MS);
    expect(onDue).not.toHaveBeenCalled();
  });
});
