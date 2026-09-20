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

const bridgingState = (over: Partial<BridgeSessionState> = {}): BridgeSessionState => ({
  status: "bridging",
  source: "Ethereum_Sepolia",
  dest: "Arc_Testnet",
  amount: "1",
  result: null,
  error: null,
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
        startedAt: 10,
      });
      expect(next).toEqual({ status: "bridging", source: "Ethereum_Sepolia", dest: "Arc_Testnet", amount: "1", result: null, error: null, startedAt: 10 });
    });

    it("refuses to start while already bridging — the guard against a second concurrent bridge", () => {
      const state = bridgingState();
      const next = bridgeSessionReducer(state, { type: "start", source: "Base", dest: "Arc", amount: "2", startedAt: 99 });
      expect(next).toBe(state);
    });
  });

  describe("finish", () => {
    it("only applies from bridging, moving to done with the result", () => {
      const next = bridgeSessionReducer(bridgingState(), { type: "finish", result });
      expect(next.status).toBe("done");
      expect(next.result).toBe(result);
      expect(next.error).toBeNull();
    });

    it("is a no-op outside bridging", () => {
      expect(bridgeSessionReducer(initialBridgeSessionState, { type: "finish", result })).toBe(initialBridgeSessionState);
    });
  });

  describe("fail", () => {
    it("only applies from bridging, moving to done with the message", () => {
      const next = bridgeSessionReducer(bridgingState(), { type: "fail", message: "Cancelled." });
      expect(next.status).toBe("done");
      expect(next.result).toBeNull();
      expect(next.error).toBe("Cancelled.");
    });

    it("is a no-op outside bridging", () => {
      expect(bridgeSessionReducer(initialBridgeSessionState, { type: "fail", message: "x" })).toBe(initialBridgeSessionState);
    });
  });

  describe("dismiss", () => {
    it("only applies from done, resetting to the initial state", () => {
      expect(bridgeSessionReducer(doneState(), { type: "dismiss" })).toEqual(initialBridgeSessionState);
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
    expect(session.start("Ethereum_Sepolia", "Arc_Testnet", "1")).toBe(true);
    expect(session.getSnapshot().status).toBe("bridging");
  });

  it("start() refuses a second concurrent bridge — one operation at a time, survives a closed window", () => {
    expect(session.start("Ethereum_Sepolia", "Arc_Testnet", "1")).toBe(true);
    expect(session.start("Base_Sepolia", "Arc_Testnet", "2")).toBe(false);
    expect(session.getSnapshot().source).toBe("Ethereum_Sepolia");
  });

  it("finish() only takes effect once bridging", () => {
    session.finish(result);
    expect(session.getSnapshot().status).toBe("idle");

    session.start("Ethereum_Sepolia", "Arc_Testnet", "1");
    session.finish(result);
    expect(session.getSnapshot()).toMatchObject({ status: "done", result });
  });

  it("dismiss() only takes effect once done", () => {
    session.dismiss(); // idle already — no-op
    expect(session.getSnapshot().status).toBe("idle");

    session.start("Ethereum_Sepolia", "Arc_Testnet", "1");
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
    s.start("Ethereum_Sepolia", "Arc_Testnet", "1");
    expect(target.addEventListener).toHaveBeenCalledTimes(1);
    expect(target.addEventListener).toHaveBeenCalledWith("beforeunload", expect.any(Function));
  });

  it("finish() removes the listener start() registered", () => {
    const target = fakeTarget();
    const s = createBridgeSession(target);
    s.start("Ethereum_Sepolia", "Arc_Testnet", "1");
    s.finish(result);
    expect(target.removeEventListener).toHaveBeenCalledTimes(1);
    expect(target.removeEventListener).toHaveBeenCalledWith("beforeunload", expect.any(Function));
  });

  it("fail() removes the listener start() registered", () => {
    const target = fakeTarget();
    const s = createBridgeSession(target);
    s.start("Ethereum_Sepolia", "Arc_Testnet", "1");
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
    expect(() => s.start("Ethereum_Sepolia", "Arc_Testnet", "1")).not.toThrow();
    expect(() => s.finish(result)).not.toThrow();
  });
});

describe("session store notifies subscribers", () => {
  it("calls every subscribed listener on start, finish, fail and dismiss, and stops after unsubscribing", () => {
    const s = createBridgeSession(undefined);
    const listener = vi.fn();
    const unsubscribe = s.subscribe(listener);

    s.start("Ethereum_Sepolia", "Arc_Testnet", "1");
    expect(listener).toHaveBeenCalledTimes(1);

    s.finish(result);
    expect(listener).toHaveBeenCalledTimes(2);

    s.dismiss();
    expect(listener).toHaveBeenCalledTimes(3);

    s.start("Base_Sepolia", "Arc_Testnet", "5");
    s.fail("nope");
    expect(listener).toHaveBeenCalledTimes(5);

    unsubscribe();
    s.dismiss();
    expect(listener).toHaveBeenCalledTimes(5);
  });
});
