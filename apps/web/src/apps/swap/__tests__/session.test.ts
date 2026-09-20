import { afterEach, describe, expect, it } from "vitest";
import type { SwapResult } from "@circle-fin/app-kit";
import { initialSwapSessionState, session, swapSessionReducer, type SwapSessionState } from "../session";

const result = { txHash: "0xabc" } as unknown as SwapResult;

const swappingState = (over: Partial<SwapSessionState> = {}): SwapSessionState => ({
  status: "swapping",
  tokenIn: "USDC",
  tokenOut: "EURC",
  amountIn: "10",
  result: null,
  error: null,
  startedAt: 1,
  ...over,
});

const doneState = (over: Partial<SwapSessionState> = {}): SwapSessionState => ({
  ...swappingState(),
  status: "done",
  result,
  ...over,
});

describe("swapSessionReducer", () => {
  describe("start", () => {
    it("starts a session from idle", () => {
      const next = swapSessionReducer(initialSwapSessionState, { type: "start", tokenIn: "USDC", tokenOut: "EURC", amountIn: "5", startedAt: 10 });
      expect(next).toEqual({ status: "swapping", tokenIn: "USDC", tokenOut: "EURC", amountIn: "5", result: null, error: null, startedAt: 10 });
    });

    it("starts a session from done", () => {
      const next = swapSessionReducer(doneState(), { type: "start", tokenIn: "EURC", tokenOut: "cirBTC", amountIn: "1", startedAt: 20 });
      expect(next.status).toBe("swapping");
      expect(next.startedAt).toBe(20);
    });

    it("refuses to start while already swapping — the guard against a second concurrent swap", () => {
      const state = swappingState();
      const next = swapSessionReducer(state, { type: "start", tokenIn: "cirBTC", tokenOut: "USDC", amountIn: "2", startedAt: 99 });
      expect(next).toBe(state);
    });
  });

  describe("finish", () => {
    it("only applies from swapping, moving to done with the result and no error", () => {
      const next = swapSessionReducer(swappingState(), { type: "finish", result });
      expect(next.status).toBe("done");
      expect(next.result).toBe(result);
      expect(next.error).toBeNull();
    });

    it("is a no-op outside swapping", () => {
      expect(swapSessionReducer(initialSwapSessionState, { type: "finish", result })).toBe(initialSwapSessionState);
    });
  });

  describe("fail", () => {
    it("only applies from swapping, moving to done with the message and no result", () => {
      const next = swapSessionReducer(swappingState(), { type: "fail", message: "The swap service is busy. Try again in a minute." });
      expect(next.status).toBe("done");
      expect(next.result).toBeNull();
      expect(next.error).toBe("The swap service is busy. Try again in a minute.");
    });

    it("is a no-op outside swapping", () => {
      expect(swapSessionReducer(initialSwapSessionState, { type: "fail", message: "x" })).toBe(initialSwapSessionState);
    });
  });

  describe("dismiss", () => {
    it("only applies from done, resetting to the initial state", () => {
      expect(swapSessionReducer(doneState(), { type: "dismiss" })).toEqual(initialSwapSessionState);
    });

    it("is a no-op outside done", () => {
      const state = swappingState();
      expect(swapSessionReducer(state, { type: "dismiss" })).toBe(state);
    });
  });
});

describe("session store", () => {
  afterEach(() => {
    if (session.getSnapshot().status === "swapping") session.fail("cleanup");
    if (session.getSnapshot().status === "done") session.dismiss();
  });

  it("start() returns true and the snapshot reflects it", () => {
    expect(session.getSnapshot().status).toBe("idle");
    expect(session.start("USDC", "EURC", "10")).toBe(true);
    expect(session.getSnapshot().status).toBe("swapping");
  });

  it("start() refuses a second concurrent swap — one operation at a time", () => {
    expect(session.start("USDC", "EURC", "10")).toBe(true);
    expect(session.start("EURC", "cirBTC", "1")).toBe(false);
    expect(session.getSnapshot().tokenIn).toBe("USDC");
  });

  it("finish() only takes effect once swapping", () => {
    session.finish(result); // no session yet — no-op
    expect(session.getSnapshot().status).toBe("idle");

    session.start("USDC", "EURC", "10");
    session.finish(result);
    expect(session.getSnapshot()).toMatchObject({ status: "done", result });
  });

  it("dismiss() only takes effect once done", () => {
    session.dismiss(); // idle already — no-op
    expect(session.getSnapshot().status).toBe("idle");

    session.start("USDC", "EURC", "10");
    session.dismiss(); // still swapping — no-op
    expect(session.getSnapshot().status).toBe("swapping");

    session.finish(result);
    session.dismiss();
    expect(session.getSnapshot()).toEqual(initialSwapSessionState);
  });
});
