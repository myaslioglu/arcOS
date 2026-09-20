import { describe, expect, it } from "vitest";
import { canSend, type CanSendInput } from "../canSend";

const BASE: CanSendInput = {
  busy: false,
  ready: true,
  decimalsKnown: true,
  textIsCurrent: true,
  rowCount: 3,
  issueCount: 0,
  sessionActive: false,
};

describe("canSend", () => {
  it("allows sending when every condition is met, labelled with how many rows will be sent", () => {
    expect(canSend(BASE)).toEqual({ ok: true, label: "Send to 3 wallets" });
  });

  it("disables while busy", () => {
    expect(canSend({ ...BASE, busy: true }).ok).toBe(false);
  });

  it("disables while a session is active — this window's send, another window's, or a reopened one's", () => {
    expect(canSend({ ...BASE, sessionActive: true }).ok).toBe(false);
  });

  it("disables when not ready (wallet, network or contract missing)", () => {
    expect(canSend({ ...BASE, ready: false }).ok).toBe(false);
  });

  it("disables while decimals aren't known — covers both still loading and a failed read", () => {
    expect(canSend({ ...BASE, decimalsKnown: false }).ok).toBe(false);
  });

  it("disables with zero rows", () => {
    const result = canSend({ ...BASE, rowCount: 0 });
    expect(result).toEqual({ ok: false, label: "Send to 0 wallets" });
  });

  it("disables on stale text even with rows present, labelled 'Checking the list…'", () => {
    const result = canSend({ ...BASE, textIsCurrent: false, rowCount: 5 });
    expect(result).toEqual({ ok: false, label: "Checking the list…" });
  });

  it("does not disable for issues alone, as long as a valid row exists — bad rows are excluded, not fatal", () => {
    expect(canSend({ ...BASE, issueCount: 4 })).toEqual({ ok: true, label: "Send to 3 wallets" });
  });

  it("labels the button with the current (non-deferred) row count", () => {
    expect(canSend({ ...BASE, rowCount: 17 }).label).toBe("Send to 17 wallets");
  });
});
