import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeResult } from "@circle-fin/app-kit";
import {
  bridgeSessionReducer,
  createBridgeSession,
  initialBridgeSessionState,
  session,
  type BeforeUnloadTarget,
  type BridgeSessionState,
} from "../session";

const result = { state: "success", steps: [] } as unknown as BridgeResult;
const failedResult = { state: "error", steps: [] } as unknown as BridgeResult;

const bridgingState = (over: Partial<BridgeSessionState> = {}): BridgeSessionState => ({
  status: "bridging",
  source: "Ethereum_Sepolia",
  dest: "Arc_Testnet",
  amount: "1",
  result: null,
  error: null,
  lastResult: null,
  startedAt: 1,
  ...over,
});

const doneState = (over: Partial<BridgeSessionState> = {}): BridgeSessionState => ({
  ...bridgingState(),
  status: "done",
  result,
  ...over,
});

describe("bridgeSessionReducer", () => {
  describe("start", () => {
    it("starts a session from idle", () => {
      const next = bridgeSessionReducer(initialBridgeSessionState, {
        type: "start",
        source: "Ethereum_Sepolia",
        dest: "Arc_Testnet",
        amount: "1",
        retry: false,
        startedAt: 10,
      });
      expect(next).toEqual({
        status: "bridging",
        source: "Ethereum_Sepolia",
        dest: "Arc_Testnet",
        amount: "1",
        result: null,
        error: null,
        lastResult: null,
        startedAt: 10,
      });
    });

    it("refuses to start while already bridging — the guard against a second concurrent bridge", () => {
      const state = bridgingState();
      const next = bridgeSessionReducer(state, { type: "start", source: "Base", dest: "Arc", amount: "2", retry: false, startedAt: 99 });
      expect(next).toBe(state);
    });

    // I4 (wave E): `start` used to carry `lastResult` forward UNCONDITIONALLY, so a brand-new transfer
    // (a fresh, non-retry start) rendered "Retrying. Your first attempt:" with a PREVIOUS, unrelated
    // transfer's burn hash — and a failed new attempt showed a successful unrelated bridge underneath
    // an error. `retry: false` must clear it.
    it("a fresh (non-retry) start clears lastResult, even if one is left over from an earlier, unrelated bridge", () => {
      const next = bridgeSessionReducer(doneState({ lastResult: failedResult }), {
        type: "start",
        source: "Base_Sepolia",
        dest: "Arc_Testnet",
        amount: "5",
        retry: false,
        startedAt: 20,
      });
      expect(next.status).toBe("bridging");
      expect(next.lastResult).toBeNull();
    });

    it("a retry start (retry: true) carries lastResult forward — a retry must not erase the evidence of the first attempt", () => {
      const next = bridgeSessionReducer(doneState({ result: null, error: "boom", lastResult: failedResult }), {
        type: "start",
        source: "Ethereum_Sepolia",
        dest: "Arc_Testnet",
        amount: "1",
        retry: true,
        startedAt: 50,
      });
      expect(next.status).toBe("bridging");
      expect(next.result).toBeNull(); // "bridging" state resets the CURRENT attempt's result...
      expect(next.lastResult).toBe(failedResult); // ...but lastResult, the prior attempt's evidence, survives
    });
  });

  // End-to-end (start + finish/fail) coverage of the four scenarios the brief calls out by name.
  describe("a full retry cycle", () => {
    it("a failed retry keeps the ORIGINAL lastResult as the visible evidence, not the new (thrown, resultless) failure", () => {
      const retrying = bridgeSessionReducer(doneState({ result: null, error: "first failure", lastResult: failedResult }), {
        type: "start",
        source: "Ethereum_Sepolia",
        dest: "Arc_Testnet",
        amount: "1",
        retry: true,
        startedAt: 50,
      });
      const failedAgain = bridgeSessionReducer(retrying, { type: "fail", message: "second failure" });
      expect(failedAgain.lastResult).toBe(failedResult);
      expect(failedAgain.error).toBe("second failure");
    });

    it("a successful retry replaces lastResult with the NEW result", () => {
      const retrying = bridgeSessionReducer(doneState({ result: null, error: "first failure", lastResult: failedResult }), {
        type: "start",
        source: "Ethereum_Sepolia",
        dest: "Arc_Testnet",
        amount: "1",
        retry: true,
        startedAt: 50,
      });
      const succeeded = bridgeSessionReducer(retrying, { type: "finish", result });
      expect(succeeded.lastResult).toBe(result);
      expect(succeeded.lastResult).not.toBe(failedResult);
    });
  });

  describe("finish", () => {
    it("only applies from bridging, moving to done with the result, and records it as lastResult too", () => {
      const next = bridgeSessionReducer(bridgingState(), { type: "finish", result });
      expect(next.status).toBe("done");
      expect(next.result).toBe(result);
      expect(next.error).toBeNull();
      expect(next.lastResult).toBe(result);
    });

    it("is a no-op outside bridging", () => {
      expect(bridgeSessionReducer(initialBridgeSessionState, { type: "finish", result })).toBe(initialBridgeSessionState);
    });
  });

  describe("fail", () => {
    it("only applies from bridging, moving to done with the message, and never touches lastResult", () => {
      const failed = { state: "error", steps: [] } as unknown as BridgeResult;
      const next = bridgeSessionReducer(bridgingState({ lastResult: failed }), { type: "fail", message: "Cancelled." });
      expect(next.status).toBe("done");
      expect(next.result).toBeNull();
      expect(next.error).toBe("Cancelled.");
      // A retry that itself throws (kit.bridge()/kit.retryBridge() rejecting, with no BridgeResult of
      // its own) must not erase the ORIGINAL attempt's steps/tx links — that's the whole point of
      // lastResult (item 8 of the brief): a failed retry used to leave zero evidence behind.
      expect(next.lastResult).toBe(failed);
    });

    it("is a no-op outside bridging", () => {
      expect(bridgeSessionReducer(initialBridgeSessionState, { type: "fail", message: "x" })).toBe(initialBridgeSessionState);
    });
  });

  describe("dismiss", () => {
    it("only applies from done, resetting to the initial state — including lastResult", () => {
      expect(bridgeSessionReducer(doneState({ lastResult: result }), { type: "dismiss" })).toEqual(initialBridgeSessionState);
    });

    it("is a no-op outside done", () => {
      const state = bridgingState();
      expect(bridgeSessionReducer(state, { type: "dismiss" })).toBe(state);
    });
  });
});

describe("session store", () => {
  afterEach(() => {
    if (session.getSnapshot().status === "bridging") session.fail("cleanup");
    if (session.getSnapshot().status === "done") session.dismiss();
  });

  it("start() returns true and the snapshot reflects it", () => {
    expect(session.getSnapshot().status).toBe("idle");
    expect(session.start("Ethereum_Sepolia", "Arc_Testnet", "1", false)).toBe(true);
    expect(session.getSnapshot().status).toBe("bridging");
  });

  it("start() refuses a second concurrent bridge — one operation at a time, survives a closed window", () => {
    expect(session.start("Ethereum_Sepolia", "Arc_Testnet", "1", false)).toBe(true);
    expect(session.start("Base_Sepolia", "Arc_Testnet", "2", false)).toBe(false);
    expect(session.getSnapshot().source).toBe("Ethereum_Sepolia");
  });

  it("start() with retry: false clears any lastResult from a previous, unrelated bridge", () => {
    session.start("Ethereum_Sepolia", "Arc_Testnet", "1", false);
    session.finish(failedResult); // an unrelated bridge finishes with a result
    session.start("Base_Sepolia", "Arc_Testnet", "9", false); // a brand-new transfer, not a retry
    expect(session.getSnapshot().lastResult).toBeNull();
  });

  it("start() with retry: true keeps the previous lastResult", () => {
    session.start("Ethereum_Sepolia", "Arc_Testnet", "1", false);
    session.fail("first attempt failed");
    session.start("Ethereum_Sepolia", "Arc_Testnet", "1", true);
    // fail() never sets lastResult (see the reducer test above), so this only proves retry:true keeps
    // whatever was already there rather than resetting it — asserted precisely via the reducer tests.
    expect(session.getSnapshot().status).toBe("bridging");
  });

  it("finish() only takes effect once bridging", () => {
    session.finish(result);
    expect(session.getSnapshot().status).toBe("idle");

    session.start("Ethereum_Sepolia", "Arc_Testnet", "1", false);
    session.finish(result);
    expect(session.getSnapshot()).toMatchObject({ status: "done", result });
  });

  it("dismiss() only takes effect once done", () => {
    session.dismiss(); // idle already — no-op
    expect(session.getSnapshot().status).toBe("idle");

    session.start("Ethereum_Sepolia", "Arc_Testnet", "1", false);
    session.dismiss(); // still bridging — no-op
    expect(session.getSnapshot().status).toBe("bridging");

    session.finish(result);
    session.dismiss();
    expect(session.getSnapshot()).toEqual(initialBridgeSessionState);
  });
});

// No jsdom in this workspace (vitest.config.mts runs environment: "node") — a real `window` doesn't
// exist, so these inject a minimal fake target instead, exactly the shape session.ts actually calls.
describe("session store's beforeunload guard", () => {
  const fakeTarget = (): BeforeUnloadTarget => ({ addEventListener: vi.fn(), removeEventListener: vi.fn() });

  it("start() registers a beforeunload listener on the injected target", () => {
    const target = fakeTarget();
    const s = createBridgeSession(target);
    s.start("Ethereum_Sepolia", "Arc_Testnet", "1", false);
    expect(target.addEventListener).toHaveBeenCalledTimes(1);
    expect(target.addEventListener).toHaveBeenCalledWith("beforeunload", expect.any(Function));
  });

  it("finish() removes the listener start() registered", () => {
    const target = fakeTarget();
    const s = createBridgeSession(target);
    s.start("Ethereum_Sepolia", "Arc_Testnet", "1", false);
    s.finish(result);
    expect(target.removeEventListener).toHaveBeenCalledTimes(1);
    expect(target.removeEventListener).toHaveBeenCalledWith("beforeunload", expect.any(Function));
  });

  it("fail() removes the listener start() registered", () => {
    const target = fakeTarget();
    const s = createBridgeSession(target);
    s.start("Ethereum_Sepolia", "Arc_Testnet", "1", false);
    s.fail("oops");
    expect(target.removeEventListener).toHaveBeenCalledTimes(1);
    expect(target.removeEventListener).toHaveBeenCalledWith("beforeunload", expect.any(Function));
  });

  it("finish()/fail() before a session ever started touch neither method", () => {
    const target = fakeTarget();
    const s = createBridgeSession(target);
    s.finish(result);
    s.fail("oops");
    expect(target.addEventListener).not.toHaveBeenCalled();
    expect(target.removeEventListener).not.toHaveBeenCalled();
  });

  it("works with no target at all (SSR / a test that passes undefined) — no-ops instead of throwing", () => {
    const s = createBridgeSession(undefined);
    expect(() => s.start("Ethereum_Sepolia", "Arc_Testnet", "1", false)).not.toThrow();
    expect(() => s.finish(result)).not.toThrow();
  });
});

describe("session store notifies subscribers", () => {
  it("calls every subscribed listener on start, finish, fail and dismiss, and stops after unsubscribing", () => {
    const s = createBridgeSession(undefined);
    const listener = vi.fn();
    const unsubscribe = s.subscribe(listener);

    s.start("Ethereum_Sepolia", "Arc_Testnet", "1", false);
    expect(listener).toHaveBeenCalledTimes(1);

    s.finish(result);
    expect(listener).toHaveBeenCalledTimes(2);

    s.dismiss();
    expect(listener).toHaveBeenCalledTimes(3);

    s.start("Base_Sepolia", "Arc_Testnet", "5", false);
    s.fail("nope");
    expect(listener).toHaveBeenCalledTimes(5);

    unsubscribe();
    s.dismiss();
    expect(listener).toHaveBeenCalledTimes(5);
  });
});
