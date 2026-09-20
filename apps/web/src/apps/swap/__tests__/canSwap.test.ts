import { describe, expect, it } from "vitest";
import { canSwap, type CanSwapInput } from "../canSwap";

const BASE: CanSwapInput = {
  sessionActive: false,
  hasConnector: true,
  liveAmount: "1",
  debouncedAmount: "1",
  amountIssue: null,
  estimateStatus: "success",
};

describe("canSwap", () => {
  it("allows swapping when every condition is met", () => {
    expect(canSwap(BASE)).toEqual({ ok: true, label: "Swap" });
  });

  it("disables while a swap session is active, labelled 'Waiting for your wallet…'", () => {
    expect(canSwap({ ...BASE, sessionActive: true })).toEqual({ ok: false, label: "Waiting for your wallet…" });
  });

  it("disables without a connected wallet", () => {
    expect(canSwap({ ...BASE, hasConnector: false }).ok).toBe(false);
  });

  it("disables with an amount issue", () => {
    expect(canSwap({ ...BASE, amountIssue: "Enter an amount" }).ok).toBe(false);
  });

  // The core bug this function exists to prevent: type 100, let the estimate settle, edit to 1
  // within the 400ms debounce window — the box reads "1" but the debounced query key (and thus the
  // showing estimate) still reflects "100". The button must go dead the instant they diverge.
  it("disables the instant the live text diverges from the debounced text — the stale-debounce case", () => {
    const result = canSwap({ ...BASE, liveAmount: "1", debouncedAmount: "100" });
    expect(result).toEqual({ ok: false, label: "Updating the quote…" });
  });

  it("disables when the estimate errored — a failed quote can't back a swap", () => {
    expect(canSwap({ ...BASE, estimateStatus: "error" }).ok).toBe(false);
  });

  it("disables while the estimate is still pending", () => {
    expect(canSwap({ ...BASE, estimateStatus: "pending" }).ok).toBe(false);
  });

  it("labels every non-stale, non-swapping state 'Swap', ok or not", () => {
    expect(canSwap({ ...BASE, estimateStatus: "error" }).label).toBe("Swap");
    expect(canSwap({ ...BASE, hasConnector: false }).label).toBe("Swap");
  });
});
