import { afterEach, describe, expect, it } from "vitest";
import type { DropResult } from "../runDrop";
import { dropSessionReducer, initialDropSessionState, session, type DropSessionState } from "../session";

const emptyResult: DropResult = { delivered: [], failed: [], remaining: [], unconfirmed: [], hashes: [], stoppedBecause: null, message: null };

const sendingState = (over: Partial<DropSessionState> = {}): DropSessionState => ({
  status: "sending",
  tokenLabel: "USDC",
  token: null,
  decimals: 6,
  progress: null,
  result: null,
  remainingText: "0x1111111111111111111111111111111111111111,1",
  excludedLines: [],
  startedAt: 1,
  ...over,
});

const doneState = (over: Partial<DropSessionState> = {}): DropSessionState => ({
  ...sendingState(),
  status: "done",
  progress: null,
  result: emptyResult,
  remainingText: "",
  ...over,
});

describe("dropSessionReducer", () => {
  describe("start", () => {
    it("starts a session from idle", () => {
      const next = dropSessionReducer(initialDropSessionState, {
        type: "start",
        tokenLabel: "USDC",
        token: null,
        decimals: 6,
        text: "0x1111111111111111111111111111111111111111,1",
        excludedLines: [],
        startedAt: 10,
      });
      expect(next).toEqual({
        status: "sending",
        tokenLabel: "USDC",
        token: null,
        decimals: 6,
        progress: null,
        result: null,
        remainingText: "0x1111111111111111111111111111111111111111,1",
        excludedLines: [],
        startedAt: 10,
      });
    });

    it("carries the parser-excluded line numbers into the session, unchanged through to done", () => {
      const started = dropSessionReducer(initialDropSessionState, {
        type: "start",
        tokenLabel: "USDC",
        token: null,
        decimals: 6,
        text: "x",
        excludedLines: [4, 9, 17],
        startedAt: 10,
      });
      expect(started.excludedLines).toEqual([4, 9, 17]);
      const finished = dropSessionReducer(started, { type: "finish", result: emptyResult, remainingText: "" });
      expect(finished.excludedLines).toEqual([4, 9, 17]);
    });

    it("starts a session from done (reviewing one result, then sending the remainder)", () => {
      const next = dropSessionReducer(doneState(), {
        type: "start",
        tokenLabel: "USDC",
        token: null,
        decimals: 6,
        text: "x",
        excludedLines: [],
        startedAt: 20,
      });
      expect(next.status).toBe("sending");
      expect(next.startedAt).toBe(20);
    });

    it("refuses to start while already sending — the hard guard against a second concurrent send", () => {
      const state = sendingState();
      const next = dropSessionReducer(state, {
        type: "start",
        tokenLabel: "USDC",
        token: null,
        decimals: 6,
        text: "a second list",
        excludedLines: [],
        startedAt: 99,
      });
      expect(next).toBe(state); // unchanged reference: the no-op IS the refusal
    });
  });

  describe("progress", () => {
    it("applies while sending", () => {
      const next = dropSessionReducer(sendingState(), { type: "progress", progress: { batch: 1, batches: 3, step: "send" } });
      expect(next.progress).toEqual({ batch: 1, batches: 3, step: "send" });
    });

    it("is a no-op outside sending", () => {
      expect(dropSessionReducer(initialDropSessionState, { type: "progress", progress: { batch: 1, batches: 1, step: "send" } })).toBe(
        initialDropSessionState,
      );
      const done = doneState();
      expect(dropSessionReducer(done, { type: "progress", progress: { batch: 1, batches: 1, step: "send" } })).toBe(done);
    });
  });

  describe("finish", () => {
    it("only applies from sending, moving to done and clearing progress", () => {
      const state = sendingState({ progress: { batch: 2, batches: 3, step: "send" } });
      const next = dropSessionReducer(state, { type: "finish", result: emptyResult, remainingText: "leftover" });
      expect(next.status).toBe("done");
      expect(next.progress).toBeNull();
      expect(next.result).toBe(emptyResult);
      expect(next.remainingText).toBe("leftover");
    });

    it("is a no-op outside sending", () => {
      expect(dropSessionReducer(initialDropSessionState, { type: "finish", result: emptyResult, remainingText: "" })).toBe(initialDropSessionState);
      const done = doneState();
      expect(dropSessionReducer(done, { type: "finish", result: emptyResult, remainingText: "" })).toBe(done);
    });
  });

  describe("dismiss", () => {
    it("only applies from done, resetting to the initial state", () => {
      const next = dropSessionReducer(doneState({ remainingText: "leftover" }), { type: "dismiss" });
      expect(next).toEqual(initialDropSessionState);
    });

    it("is a no-op outside done", () => {
      expect(dropSessionReducer(initialDropSessionState, { type: "dismiss" })).toBe(initialDropSessionState);
      const state = sendingState();
      expect(dropSessionReducer(state, { type: "dismiss" })).toBe(state);
    });
  });
});

describe("session store", () => {
  // The store is a module-level singleton shared across every test in this file — always leave it idle
  // afterward regardless of what a test did, so tests never leak into each other.
  afterEach(() => {
    if (session.getSnapshot().status === "sending") session.finish(emptyResult, "");
    if (session.getSnapshot().status === "done") session.dismiss();
  });

  it("start() returns true and the snapshot reflects it", () => {
    expect(session.getSnapshot().status).toBe("idle");
    const started = session.start("USDC", null, 6, "0x1111111111111111111111111111111111111111,1");
    expect(started).toBe(true);
    expect(session.getSnapshot().status).toBe("sending");
  });

  it("start() refuses a second concurrent send — the hard guard against any number of windows or clicks", () => {
    expect(session.start("USDC", null, 6, "list one")).toBe(true);
    expect(session.start("USDC", null, 6, "list two")).toBe(false);
    // The second, refused call changed nothing: the session still reflects the first list.
    expect(session.getSnapshot().remainingText).toBe("list one");
  });

  it("start() defaults excludedLines to an empty array when the caller omits it", () => {
    session.start("USDC", null, 6, "x");
    expect(session.getSnapshot().excludedLines).toEqual([]);
  });

  it("start() records the excluded line numbers the caller passes", () => {
    session.start("USDC", null, 6, "x", [2, 5]);
    expect(session.getSnapshot().excludedLines).toEqual([2, 5]);
  });

  it("setProgress() only takes effect once a session is sending", () => {
    session.setProgress({ batch: 1, batches: 1, step: "send" }); // no session yet — no-op
    expect(session.getSnapshot().progress).toBeNull();

    session.start("USDC", null, 6, "x");
    session.setProgress({ batch: 1, batches: 2, step: "send" });
    expect(session.getSnapshot().progress).toEqual({ batch: 1, batches: 2, step: "send" });
  });

  it("finish() only takes effect once a session is sending", () => {
    session.finish(emptyResult, ""); // no session yet — no-op
    expect(session.getSnapshot().status).toBe("idle");

    session.start("USDC", null, 6, "x");
    session.finish(emptyResult, "leftover");
    expect(session.getSnapshot()).toMatchObject({ status: "done", result: emptyResult, remainingText: "leftover" });
  });

  it("dismiss() only takes effect once a session is done, returning to idle", () => {
    session.dismiss(); // idle already — no-op
    expect(session.getSnapshot().status).toBe("idle");

    session.start("USDC", null, 6, "x");
    session.dismiss(); // still sending — no-op
    expect(session.getSnapshot().status).toBe("sending");

    session.finish(emptyResult, "");
    session.dismiss();
    expect(session.getSnapshot()).toEqual(initialDropSessionState);
  });

  it("subscribe() notifies listeners on a change and not on a refused start", () => {
    let calls = 0;
    const unsubscribe = session.subscribe(() => calls++);
    session.start("USDC", null, 6, "x"); // change
    const callsAfterStart = calls;
    session.start("USDC", null, 6, "y"); // refused, no change
    expect(calls).toBe(callsAfterStart);
    unsubscribe();
  });
});
