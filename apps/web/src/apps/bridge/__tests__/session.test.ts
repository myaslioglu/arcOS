import { afterEach, describe, expect, it } from "vitest";
import type { BridgeResult } from "@circle-fin/app-kit";
import { bridgeSessionReducer, initialBridgeSessionState, session, type BridgeSessionState } from "../session";

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
});
