import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMintSession,
  initialMintSessionState,
  mintSessionReducer,
  session,
  type BeforeUnloadTarget,
  type MintSessionState,
} from "../session";

const result = { token: "0x1111111111111111111111111111111111111111", symbol: "DUKE", decimals: 18 } as const;

const mintingState = (over: Partial<MintSessionState> = {}): MintSessionState => ({
  status: "minting",
  symbol: "DUKE",
  result: null,
  error: null,
  startedAt: 1,
  ...over,
});

const doneState = (over: Partial<MintSessionState> = {}): MintSessionState => ({
  ...mintingState(),
  status: "done",
  result,
  ...over,
});

describe("mintSessionReducer", () => {
  describe("start", () => {
    it("starts a session from idle", () => {
      const next = mintSessionReducer(initialMintSessionState, { type: "start", symbol: "DUKE", startedAt: 10 });
      expect(next).toEqual({ status: "minting", symbol: "DUKE", result: null, error: null, startedAt: 10 });
    });

    it("starts a session from done (minting another token after one finished)", () => {
      const next = mintSessionReducer(doneState(), { type: "start", symbol: "OTHER", startedAt: 20 });
      expect(next.status).toBe("minting");
      expect(next.symbol).toBe("OTHER");
      expect(next.startedAt).toBe(20);
    });

    it("refuses to start while already minting — one paid mint in flight at a time", () => {
      const state = mintingState();
      const next = mintSessionReducer(state, { type: "start", symbol: "SECOND", startedAt: 99 });
      expect(next).toBe(state);
    });
  });

  describe("finish", () => {
    it("only applies from minting, moving to done with the created token", () => {
      const next = mintSessionReducer(mintingState(), { type: "finish", result });
      expect(next.status).toBe("done");
      expect(next.result).toBe(result);
      expect(next.error).toBeNull();
    });

    it("is a no-op outside minting", () => {
      expect(mintSessionReducer(initialMintSessionState, { type: "finish", result })).toBe(initialMintSessionState);
      const done = doneState();
      expect(mintSessionReducer(done, { type: "finish", result })).toBe(done);
    });
  });

  describe("fail", () => {
    it("only applies from minting, moving to done with the message", () => {
      const next = mintSessionReducer(mintingState(), { type: "fail", message: "The fee changed." });
      expect(next.status).toBe("done");
      expect(next.result).toBeNull();
      expect(next.error).toBe("The fee changed.");
    });

    it("is a no-op outside minting", () => {
      expect(mintSessionReducer(initialMintSessionState, { type: "fail", message: "x" })).toBe(initialMintSessionState);
    });
  });

  describe("dismiss", () => {
    it("only applies from done, resetting to the initial state", () => {
      expect(mintSessionReducer(doneState(), { type: "dismiss" })).toEqual(initialMintSessionState);
    });

    it("is a no-op outside done", () => {
      const state = mintingState();
      expect(mintSessionReducer(state, { type: "dismiss" })).toBe(state);
    });
  });
});

describe("session store", () => {
  afterEach(() => {
    if (session.getSnapshot().status === "minting") session.fail("cleanup");
    if (session.getSnapshot().status === "done") session.dismiss();
  });

  it("start() returns true and the snapshot reflects it", () => {
    expect(session.getSnapshot().status).toBe("idle");
    expect(session.start("DUKE")).toBe(true);
    expect(session.getSnapshot().status).toBe("minting");
  });

  it("start() refuses a second concurrent mint — survives a closed window", () => {
    expect(session.start("DUKE")).toBe(true);
    expect(session.start("OTHER")).toBe(false);
    expect(session.getSnapshot().symbol).toBe("DUKE");
  });

  it("finish() only takes effect once minting", () => {
    session.finish(result);
    expect(session.getSnapshot().status).toBe("idle");

    session.start("DUKE");
    session.finish(result);
    expect(session.getSnapshot()).toMatchObject({ status: "done", result });
  });

  it("dismiss() only takes effect once done", () => {
    session.dismiss(); // idle already — no-op
    expect(session.getSnapshot().status).toBe("idle");

    session.start("DUKE");
    session.dismiss(); // still minting — no-op
    expect(session.getSnapshot().status).toBe("minting");

    session.finish(result);
    session.dismiss();
    expect(session.getSnapshot()).toEqual(initialMintSessionState);
  });
});

// No jsdom in this workspace (vitest.config.mts runs environment: "node") — inject a minimal fake
// target instead of a real `window`, exactly the shape session.ts actually calls.
describe("session store's beforeunload guard", () => {
  const fakeTarget = (): BeforeUnloadTarget => ({ addEventListener: vi.fn(), removeEventListener: vi.fn() });

  it("start() registers a beforeunload listener on the injected target", () => {
    const target = fakeTarget();
    const s = createMintSession(target);
    s.start("DUKE");
    expect(target.addEventListener).toHaveBeenCalledTimes(1);
    expect(target.addEventListener).toHaveBeenCalledWith("beforeunload", expect.any(Function));
  });

  it("finish() removes the listener start() registered", () => {
    const target = fakeTarget();
    const s = createMintSession(target);
    s.start("DUKE");
    s.finish(result);
    expect(target.removeEventListener).toHaveBeenCalledTimes(1);
  });

  it("fail() removes the listener start() registered", () => {
    const target = fakeTarget();
    const s = createMintSession(target);
    s.start("DUKE");
    s.fail("oops");
    expect(target.removeEventListener).toHaveBeenCalledTimes(1);
  });

  it("works with no target at all (SSR / a test that passes undefined) — no-ops instead of throwing", () => {
    const s = createMintSession(undefined);
    expect(() => s.start("DUKE")).not.toThrow();
    expect(() => s.finish(result)).not.toThrow();
  });
});

describe("session store notifies subscribers", () => {
  it("calls every subscribed listener on start, finish and dismiss, and stops after unsubscribing", () => {
    const s = createMintSession(undefined);
    const listener = vi.fn();
    const unsubscribe = s.subscribe(listener);

    s.start("DUKE");
    expect(listener).toHaveBeenCalledTimes(1);

    s.finish(result);
    expect(listener).toHaveBeenCalledTimes(2);

    s.dismiss();
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    s.start("DUKE");
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
