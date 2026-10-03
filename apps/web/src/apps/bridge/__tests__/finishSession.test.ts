import { describe, expect, it, vi } from "vitest";
import { createFinishSession, finishSessionReducer, initialFinishSessionState, type FinishSessionState } from "../finishSession";

const BURN = `0x${"7b".repeat(32)}` as const;
const MINT = `0x${"11".repeat(32)}` as const;

const working: FinishSessionState = { ...initialFinishSessionState, status: "working", burnTxHash: BURN };

describe("finishSessionReducer", () => {
  it("starts from idle, and from done, with everything else cleared", () => {
    expect(finishSessionReducer(initialFinishSessionState, { type: "start", burnTxHash: BURN })).toEqual(working);
    const done: FinishSessionState = { ...working, status: "done", dest: "Base", mintTxHash: MINT };
    expect(finishSessionReducer(done, { type: "start", burnTxHash: BURN })).toEqual(working);
  });

  it("refuses a second start while working", () => {
    expect(finishSessionReducer(working, { type: "start", burnTxHash: MINT })).toBe(working);
  });

  it("records the destination, then the mint, the delivery, or the failure, only while working", () => {
    const withDest = finishSessionReducer(working, { type: "destination", dest: "Base" });
    expect(withDest.dest).toBe("Base");
    expect(finishSessionReducer(withDest, { type: "minted", mintTxHash: MINT })).toEqual({ ...withDest, status: "done", mintTxHash: MINT, error: null });
    expect(finishSessionReducer(withDest, { type: "delivered" })).toEqual({ ...withDest, status: "done", alreadyDelivered: true, error: null });
    expect(finishSessionReducer(withDest, { type: "fail", message: "No." })).toEqual({ ...withDest, status: "done", mintTxHash: null, error: "No." });
    for (const action of [{ type: "destination", dest: "Base" }, { type: "minted", mintTxHash: MINT }, { type: "delivered" }, { type: "fail", message: "x" }] as const) {
      expect(finishSessionReducer(initialFinishSessionState, action), action.type).toBe(initialFinishSessionState);
    }
  });

  it("dismisses only a done session", () => {
    const done = finishSessionReducer(working, { type: "fail", message: "No." });
    expect(finishSessionReducer(done, { type: "dismiss" })).toBe(initialFinishSessionState);
    expect(finishSessionReducer(working, { type: "dismiss" })).toBe(working);
    expect(finishSessionReducer(initialFinishSessionState, { type: "dismiss" })).toBe(initialFinishSessionState);
  });
});

describe("createFinishSession", () => {
  it("runs one finish at a time and tells its subscribers of every change", () => {
    const s = createFinishSession();
    const changes = vi.fn();
    s.subscribe(changes);
    expect(s.start(BURN)).toBe(true);
    expect(s.start(MINT), "a second finish while one works").toBe(false);
    expect(s.destination("Base")).toBe(true);
    expect(s.minted(MINT)).toBe(true);
    expect(s.getSnapshot()).toMatchObject({ status: "done", burnTxHash: BURN, dest: "Base", mintTxHash: MINT, error: null });
    expect(s.fail("late"), "a failure after done changes nothing").toBe(false);
    expect(s.dismiss()).toBe(true);
    expect(s.getSnapshot()).toBe(initialFinishSessionState);
    expect(changes).toHaveBeenCalledTimes(4);
  });
});
