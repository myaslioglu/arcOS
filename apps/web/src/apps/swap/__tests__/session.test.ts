import { afterEach, describe, expect, it, vi } from "vitest";
import { KitError, RateLimitError, type SwapResult } from "@circle-fin/app-kit";
import { EMBEDDED_FRAME_MESSAGE } from "@/lib/wallet-frame";
import {
  STOPPED_WAITING_MESSAGE,
  classifySwapFailure,
  createSwapSession,
  locksForm,
  initialSwapSessionState,
  session,
  swapSessionReducer,
  type BeforeUnloadTarget,
  type SwapSessionState,
} from "../session";

const result = { txHash: "0xabc" } as unknown as SwapResult;

const swappingState = (over: Partial<SwapSessionState> = {}): SwapSessionState => ({
  status: "swapping",
  tokenIn: "USDC",
  tokenOut: "EURC",
  amountIn: "10",
  result: null,
  error: null,
  startedAt: 1,
  runId: 1,
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
      const next = swapSessionReducer(initialSwapSessionState, { type: "start", tokenIn: "USDC", tokenOut: "EURC", amountIn: "5", startedAt: 10, runId: 1 });
      expect(next).toEqual({ status: "swapping", tokenIn: "USDC", tokenOut: "EURC", amountIn: "5", result: null, error: null, startedAt: 10, runId: 1 });
    });

    it("starts a session from done", () => {
      const next = swapSessionReducer(doneState(), { type: "start", tokenIn: "EURC", tokenOut: "cirBTC", amountIn: "1", startedAt: 20, runId: 2 });
      expect(next.status).toBe("swapping");
      expect(next.startedAt).toBe(20);
    });

    it("refuses to start while already swapping — the guard against a second concurrent swap", () => {
      const state = swappingState();
      const next = swapSessionReducer(state, { type: "start", tokenIn: "cirBTC", tokenOut: "USDC", amountIn: "2", startedAt: 99, runId: 2 });
      expect(next).toBe(state);
    });
  });

  describe("finish", () => {
    it("only applies from swapping, moving to done with the result and no error", () => {
      const next = swapSessionReducer(swappingState(), { type: "finish", result, runId: 1 });
      expect(next.status).toBe("done");
      expect(next.result).toBe(result);
      expect(next.error).toBeNull();
    });

    it("is a no-op outside swapping", () => {
      expect(swapSessionReducer(initialSwapSessionState, { type: "finish", result, runId: 1 })).toBe(initialSwapSessionState);
    });
  });

  describe("fail", () => {
    it("only applies from swapping, moving to done with the message and no result", () => {
      const next = swapSessionReducer(swappingState(), { type: "fail", message: "The swap service is busy. Try again in a minute.", runId: 1 });
      expect(next.status).toBe("done");
      expect(next.result).toBeNull();
      expect(next.error).toBe("The swap service is busy. Try again in a minute.");
    });

    it("is a no-op outside swapping", () => {
      expect(swapSessionReducer(initialSwapSessionState, { type: "fail", message: "x", runId: 1 })).toBe(initialSwapSessionState);
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

// The swap that never came back: a wallet that never showed the request (or lost it) left kit.swap() pending for good,
// and the window said "swapping" until a reload. "Stop waiting" ends the run with its outcome unknown, and run ids keep
// the abandoned promise, when it finally settles, from overwriting a newer run.
describe("swapSessionReducer: stop waiting and stale runs", () => {
  const stoppedState = (over: Partial<SwapSessionState> = {}): SwapSessionState => ({ ...swappingState(), status: "stopped", ...over });

  it("stop moves the run swapping now to stopped, with neither a result nor an error", () => {
    const next = swapSessionReducer(swappingState({ runId: 3 }), { type: "stop", runId: 3 });
    expect(next).toMatchObject({ status: "stopped", result: null, error: null, runId: 3, tokenIn: "USDC", amountIn: "10" });
  });

  it("stop is a no-op for another run, or outside swapping", () => {
    const swapping = swappingState({ runId: 3 });
    expect(swapSessionReducer(swapping, { type: "stop", runId: 2 })).toBe(swapping);
    const done = doneState();
    expect(swapSessionReducer(done, { type: "stop", runId: 1 })).toBe(done);
    expect(swapSessionReducer(initialSwapSessionState, { type: "stop", runId: 0 })).toBe(initialSwapSessionState);
  });

  it("a stopped run frees the form: a new start is accepted", () => {
    const next = swapSessionReducer(stoppedState(), { type: "start", tokenIn: "EURC", tokenOut: "USDC", amountIn: "3", startedAt: 50, runId: 2 });
    expect(next).toMatchObject({ status: "swapping", tokenIn: "EURC", amountIn: "3", runId: 2, result: null, error: null });
  });

  it("ignores a late finish or fail from an older run while a newer one is swapping", () => {
    const newer = swappingState({ runId: 2, tokenIn: "EURC" });
    expect(swapSessionReducer(newer, { type: "finish", result, runId: 1 })).toBe(newer);
    expect(swapSessionReducer(newer, { type: "fail", message: "Cancelled.", runId: 1 })).toBe(newer);
  });

  it("ignores a late finish or fail from an older run once a newer one is done", () => {
    const newer = doneState({ runId: 2, result: { txHash: "0xdef" } as unknown as SwapResult });
    expect(swapSessionReducer(newer, { type: "finish", result, runId: 1 })).toBe(newer);
    expect(swapSessionReducer(newer, { type: "fail", message: "x", runId: 1 })).toBe(newer);
  });

  it("lets the stopped run's own late answer replace 'unknown' with what really happened", () => {
    expect(swapSessionReducer(stoppedState(), { type: "finish", result, runId: 1 })).toMatchObject({ status: "done", result, error: null });
    expect(swapSessionReducer(stoppedState(), { type: "fail", message: "Cancelled.", runId: 1 })).toMatchObject({ status: "done", result: null, error: "Cancelled." });
  });

  it("only a swapping run locks the form: stopping waiting re-enables it", () => {
    expect(locksForm(swappingState())).toBe(true);
    expect(locksForm(swapSessionReducer(swappingState(), { type: "stop", runId: 1 }))).toBe(false);
    expect(locksForm(doneState())).toBe(false);
    expect(locksForm(initialSwapSessionState)).toBe(false);
  });

  it("dismiss from stopped returns to a blank form", () => {
    expect(swapSessionReducer(stoppedState(), { type: "dismiss" })).toEqual(initialSwapSessionState);
  });
});

describe("STOPPED_WAITING_MESSAGE", () => {
  it("never claims the swap failed, says it may still complete, and asks for a check before swapping again", () => {
    expect(STOPPED_WAITING_MESSAGE).not.toMatch(/fail|didn't go through|try again/i);
    expect(STOPPED_WAITING_MESSAGE).toMatch(/will still complete/);
    expect(STOPPED_WAITING_MESSAGE).toMatch(/Check your balance/);
    expect(STOPPED_WAITING_MESSAGE).toMatch(/swap twice/);
  });
});

describe("session store: stop waiting", () => {
  const fakeTarget = (): BeforeUnloadTarget => ({ addEventListener: vi.fn(), removeEventListener: vi.fn() });

  it("stop() frees the form, drops the beforeunload guard and notifies", () => {
    const target = fakeTarget();
    const s = createSwapSession(target);
    const listener = vi.fn();
    s.subscribe(listener);
    const runId = s.start("USDC", "EURC", "10")!;
    expect(s.stop(runId)).toBe(true);
    expect(s.getSnapshot()).toMatchObject({ status: "stopped", result: null, error: null });
    expect(target.removeEventListener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(s.start("EURC", "USDC", "1")).not.toBeNull();
  });

  it("the abandoned run settling late doesn't touch the newer run", () => {
    const s = createSwapSession(undefined);
    const first = s.start("USDC", "EURC", "10")!;
    s.stop(first);
    const second = s.start("EURC", "USDC", "1")!;
    expect(second).not.toBe(first);

    expect(s.finish(result, first)).toBe(false);
    expect(s.fail("Cancelled.", first)).toBe(false);
    expect(s.getSnapshot()).toMatchObject({ status: "swapping", runId: second, tokenIn: "EURC", result: null, error: null });

    const own = { txHash: "0xdef" } as unknown as SwapResult;
    expect(s.finish(own, second)).toBe(true);
    expect(s.finish(result, first)).toBe(false);
    expect(s.getSnapshot()).toMatchObject({ status: "done", runId: second, result: own });
  });

  it("stop() for a run that isn't swapping changes nothing and doesn't notify", () => {
    const s = createSwapSession(undefined);
    const listener = vi.fn();
    s.subscribe(listener);
    expect(s.stop(1)).toBe(false);
    const runId = s.start("USDC", "EURC", "10")!;
    s.finish(result, runId);
    expect(s.stop(runId)).toBe(false);
    expect(s.getSnapshot().status).toBe("done");
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

// The follow-up this wave fixes: Swap's submit catch-all used to fall back to
// GENERIC_TRANSACTION_ERROR ("...Try again."), same as every other unrecognized wallet/RPC/SDK
// failure this app shows — safe text, but "Try again" reads as "nothing happened", and a swap whose
// promise rejected AFTER it was actually broadcast (a lost wallet response, a timeout) could invite a
// second, separately-charged swap. Mirrors Mint's classifyMintFailure (mint/session.ts): pulled out as
// a pure function so it's unit-tested without a live wallet/RPC/SDK.
describe("classifySwapFailure", () => {
  it("says to reload when the wallet took the page for an embedded frame: it refused the first request, so nothing was sent", () => {
    const text = "Request blocked: embedded frames are not allowed for this origin. For your security, 4rcos.com can't make this request from an embedded frame.";
    const err = new Error("Swap failed", { cause: { trace: { originalError: new Error(text) } } });
    expect(classifySwapFailure(err)).toBe(EMBEDDED_FRAME_MESSAGE);
  });

  it("reads as a rejection and keeps its own sentence — nothing was ever signed, so there's nothing to hedge about", () => {
    const err = new Error("User rejected the request");
    expect(classifySwapFailure(err)).toBe("Cancelled.");
  });

  it("reads a rate limit (a real KitError) as busy, and still hedges: kit.swap() also calls the API after the wallet sends", () => {
    const err = new KitError({ ...RateLimitError.RATE_LIMIT_EXCEEDED, recoverability: "RETRYABLE", message: "Rate limit exceeded, please retry later" });
    expect(classifySwapFailure(err)).toBe("The swap service is busy, and the swap may still have gone through. Check your wallet's activity before trying again in a minute.");
  });

  // The defect this follow-up fixes: kit.swap() is one opaque promise with no signal for whether a
  // transaction actually went out before it rejected (no onProgress/hash callback — see SwapParams/
  // SwapConfig in node_modules/@circle-fin/app-kit/index.d.ts). A rejection that isn't a recognized
  // cancellation or rate limit could just as easily follow a lost wallet response or a timeout AFTER
  // the swap was broadcast, so it must never say "Try again" alone — that reads as "nothing happened"
  // and could invite a second, separately-charged swap. Mirrors Bridge's identical hedge
  // (bridge/Window.tsx, inFlight.ts's explorerCheckNote) for the same reason.
  it("hedges an unrecognized failure instead of inviting a second payment — never 'try again' alone, and never the error's own text", () => {
    const err = new Error("some raw detail: https://internal.example/x");
    const message = classifySwapFailure(err);
    expect(message).toBe("The swap didn't finish. It may still have gone through, so check your wallet's activity before trying again.");
    expect(message).not.toMatch(/internal\.example/);
  });

  it("hedges a thrown non-Error value the same way", () => {
    expect(classifySwapFailure("nope")).toBe("The swap didn't finish. It may still have gone through, so check your wallet's activity before trying again.");
    expect(classifySwapFailure(null)).toBe("The swap didn't finish. It may still have gone through, so check your wallet's activity before trying again.");
  });
});

describe("session store", () => {
  afterEach(() => {
    const { status, runId } = session.getSnapshot();
    if (status === "swapping") session.fail("cleanup", runId);
    if (session.getSnapshot().status !== "idle") session.dismiss();
  });

  it("start() returns a run id and the snapshot reflects it", () => {
    expect(session.getSnapshot().status).toBe("idle");
    const runId = session.start("USDC", "EURC", "10");
    expect(runId).toEqual(expect.any(Number));
    expect(session.getSnapshot()).toMatchObject({ status: "swapping", runId });
  });

  it("start() refuses a second concurrent swap — one operation at a time", () => {
    expect(session.start("USDC", "EURC", "10")).not.toBeNull();
    expect(session.start("EURC", "cirBTC", "1")).toBeNull();
    expect(session.getSnapshot().tokenIn).toBe("USDC");
  });

  it("finish() only takes effect once swapping", () => {
    session.finish(result, session.getSnapshot().runId); // no session yet — no-op
    expect(session.getSnapshot().status).toBe("idle");

    const runId = session.start("USDC", "EURC", "10")!;
    session.finish(result, runId);
    expect(session.getSnapshot()).toMatchObject({ status: "done", result });
  });

  it("dismiss() only takes effect once done", () => {
    session.dismiss(); // idle already — no-op
    expect(session.getSnapshot().status).toBe("idle");

    const runId = session.start("USDC", "EURC", "10")!;
    session.dismiss(); // still swapping — no-op
    expect(session.getSnapshot().status).toBe("swapping");

    session.finish(result, runId);
    session.dismiss();
    expect(session.getSnapshot()).toEqual(initialSwapSessionState);
  });
});

// No jsdom in this workspace (vitest.config.mts runs environment: "node") — a real `window` doesn't
// exist, so these inject a minimal fake target instead, exactly the shape session.ts actually calls.
describe("session store's beforeunload guard", () => {
  const fakeTarget = (): BeforeUnloadTarget => ({ addEventListener: vi.fn(), removeEventListener: vi.fn() });

  it("start() registers a beforeunload listener on the injected target", () => {
    const target = fakeTarget();
    const s = createSwapSession(target);
    s.start("USDC", "EURC", "10");
    expect(target.addEventListener).toHaveBeenCalledTimes(1);
    expect(target.addEventListener).toHaveBeenCalledWith("beforeunload", expect.any(Function));
    expect(target.removeEventListener).not.toHaveBeenCalled();
  });

  it("finish() removes the listener start() registered", () => {
    const target = fakeTarget();
    const s = createSwapSession(target);
    s.start("USDC", "EURC", "10");
    s.finish(result, s.getSnapshot().runId);
    expect(target.removeEventListener).toHaveBeenCalledTimes(1);
    expect(target.removeEventListener).toHaveBeenCalledWith("beforeunload", expect.any(Function));
  });

  it("fail() removes the listener start() registered", () => {
    const target = fakeTarget();
    const s = createSwapSession(target);
    s.start("USDC", "EURC", "10");
    s.fail("oops", s.getSnapshot().runId);
    expect(target.removeEventListener).toHaveBeenCalledTimes(1);
    expect(target.removeEventListener).toHaveBeenCalledWith("beforeunload", expect.any(Function));
  });

  it("finish()/fail() before a session ever started touch neither method", () => {
    const target = fakeTarget();
    const s = createSwapSession(target);
    s.finish(result, s.getSnapshot().runId);
    s.fail("oops", s.getSnapshot().runId);
    expect(target.addEventListener).not.toHaveBeenCalled();
    expect(target.removeEventListener).not.toHaveBeenCalled();
  });

  it("a second start() while already swapping is refused and doesn't re-register", () => {
    const target = fakeTarget();
    const s = createSwapSession(target);
    s.start("USDC", "EURC", "10");
    s.start("EURC", "cirBTC", "1");
    expect(target.addEventListener).toHaveBeenCalledTimes(1);
  });

  it("works with no target at all (SSR / a test that passes undefined) — no-ops instead of throwing", () => {
    const s = createSwapSession(undefined);
    expect(() => s.start("USDC", "EURC", "10")).not.toThrow();
    expect(() => s.finish(result, s.getSnapshot().runId)).not.toThrow();
  });
});

describe("session store notifies subscribers", () => {
  it("calls every subscribed listener on start, finish, fail and dismiss, and stops after unsubscribing", () => {
    const s = createSwapSession(undefined);
    const listener = vi.fn();
    const unsubscribe = s.subscribe(listener);

    s.start("USDC", "EURC", "10");
    expect(listener).toHaveBeenCalledTimes(1);

    s.finish(result, s.getSnapshot().runId);
    expect(listener).toHaveBeenCalledTimes(2);

    s.dismiss();
    expect(listener).toHaveBeenCalledTimes(3);

    s.start("EURC", "USDC", "5");
    s.fail("nope", s.getSnapshot().runId);
    expect(listener).toHaveBeenCalledTimes(5);

    unsubscribe();
    s.dismiss();
    expect(listener).toHaveBeenCalledTimes(5);
  });

  it("a no-op action (e.g. start() while already swapping) does not notify", () => {
    const s = createSwapSession(undefined);
    const listener = vi.fn();
    s.subscribe(listener);
    s.start("USDC", "EURC", "10");
    expect(listener).toHaveBeenCalledTimes(1);
    s.start("EURC", "cirBTC", "1"); // refused — already swapping
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
