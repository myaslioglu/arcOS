import { afterEach, describe, expect, it, vi } from "vitest";
import { notifyBalanceChanged, watchBalanceChanges } from "../balance-refresh";

afterEach(() => vi.useRealTimers());

describe("balance refresh", () => {
  it("invalidates balance and contract reads now and once more later", () => {
    vi.useFakeTimers();
    const invalidateQueries = vi.fn();
    const stop = watchBalanceChanges({ invalidateQueries }, 1000);
    notifyBalanceChanged();
    expect(invalidateQueries.mock.calls.map((c) => c[0].queryKey)).toEqual([["balance"], ["readContract"]]);
    vi.advanceTimersByTime(1000);
    expect(invalidateQueries).toHaveBeenCalledTimes(4);
    stop();
  });
  it("stops after unsubscribe", () => {
    vi.useFakeTimers();
    const invalidateQueries = vi.fn();
    watchBalanceChanges({ invalidateQueries }, 1000)();
    notifyBalanceChanged();
    vi.advanceTimersByTime(5000);
    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});
