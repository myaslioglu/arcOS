import { afterEach, describe, expect, it, vi } from "vitest";
import { UserFacingError } from "@/lib/contract-error";
import {
  classifyMintFailure,
  createMintSession,
  initialMintSessionState,
  mintSessionReducer,
  session,
  type BeforeUnloadTarget,
  type MintSessionState,
} from "../session";

const result = { token: "0x1111111111111111111111111111111111111111", symbol: "DUKE", decimals: 18 } as const;
const HASH = "0x2222222222222222222222222222222222222222222222222222222222222222" as const;

const mintingState = (over: Partial<MintSessionState> = {}): MintSessionState => ({
  status: "minting",
  symbol: "DUKE",
  result: null,
  error: null,
  hash: null,
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
      expect(next).toEqual({ status: "minting", symbol: "DUKE", result: null, error: null, hash: null, startedAt: 10 });
    });

    it("starts a session from done (minting another token after one finished)", () => {
      const next = mintSessionReducer(doneState(), { type: "start", symbol: "OTHER", startedAt: 20 });
      expect(next.status).toBe("minting");
      expect(next.symbol).toBe("OTHER");
      expect(next.startedAt).toBe(20);
    });

    it("starts a session from unconfirmed (a new mint after a prior one's receipt couldn't be confirmed)", () => {
      const next = mintSessionReducer(mintSessionReducer(mintingState(), { type: "unconfirmed", message: "x", hash: HASH }), {
        type: "start",
        symbol: "OTHER",
        startedAt: 30,
      });
      expect(next.status).toBe("minting");
      expect(next.hash).toBeNull();
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

  describe("unconfirmed", () => {
    it("only applies from minting, moving to 'unconfirmed' with the message and hash — never 'done'", () => {
      const next = mintSessionReducer(mintingState(), { type: "unconfirmed", message: "Check the explorer.", hash: HASH });
      expect(next.status).toBe("unconfirmed");
      expect(next.error).toBe("Check the explorer.");
      expect(next.hash).toBe(HASH);
      expect(next.result).toBeNull();
    });

    it("is a no-op outside minting", () => {
      expect(mintSessionReducer(initialMintSessionState, { type: "unconfirmed", message: "x", hash: HASH })).toBe(initialMintSessionState);
      const done = doneState();
      expect(mintSessionReducer(done, { type: "unconfirmed", message: "x", hash: HASH })).toBe(done);
    });
  });

  describe("dismiss", () => {
    it("only applies from done, resetting to the initial state", () => {
      expect(mintSessionReducer(doneState(), { type: "dismiss" })).toEqual(initialMintSessionState);
    });

    it("also applies from unconfirmed — the user has seen the hash and chosen to move on", () => {
      const unconfirmed = mintSessionReducer(mintingState(), { type: "unconfirmed", message: "x", hash: HASH });
      expect(mintSessionReducer(unconfirmed, { type: "dismiss" })).toEqual(initialMintSessionState);
    });

    it("is a no-op outside done/unconfirmed", () => {
      const state = mintingState();
      expect(mintSessionReducer(state, { type: "dismiss" })).toBe(state);
    });
  });
});

describe("classifyMintFailure", () => {
  it("passes a UserFacingError through verbatim and never marks it unconfirmed — the receipt was already obtained, so the outcome is definite", () => {
    const err = new UserFacingError("The transaction reverted — no token was created and the fee wasn't taken. Check the fee and try again.");
    expect(classifyMintFailure(true, err)).toEqual({
      message: "The transaction reverted — no token was created and the fee wasn't taken. Check the fee and try again.",
      unconfirmed: false,
    });
    // Even though a hash is known (the tx WAS mined — we just got a revert receipt), this is not
    // "unconfirmed": we have a definite, on-chain answer.
  });

  it("treats a non-UserFacingError failure after the hash is known as unconfirmed — e.g. waitForTransactionReceipt itself rejecting (timeout, RPC drop)", () => {
    const err = new Error("timeout while waiting for transaction receipt");
    expect(classifyMintFailure(true, err)).toEqual({
      message: "Your transaction was sent but we couldn't confirm it. Check it on the explorer before minting again.",
      unconfirmed: true,
    });
  });

  it("uses the normal describeContractError path when no hash was ever obtained — nothing was sent, so there's nothing to confirm", () => {
    const err = Object.assign(new Error("denied"), { name: "UserRejectedRequestError" });
    expect(classifyMintFailure(false, err)).toEqual({ message: "You cancelled the request in your wallet.", unconfirmed: false });
  });

  it("a UserFacingError with no hash known (e.g. a stale-fee stop before signing) is also never unconfirmed", () => {
    const err = new UserFacingError("The fee changed to 15 USDC. Check it and submit again.");
    expect(classifyMintFailure(false, err)).toEqual({ message: "The fee changed to 15 USDC. Check it and submit again.", unconfirmed: false });
  });
});

describe("session store", () => {
  afterEach(() => {
    if (session.getSnapshot().status === "minting") session.fail("cleanup");
    if (session.getSnapshot().status === "done" || session.getSnapshot().status === "unconfirmed") session.dismiss();
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

  it("unconfirmed() only takes effect once minting, and keeps the hash visible", () => {
    session.unconfirmed("Check the explorer.", HASH);
    expect(session.getSnapshot().status).toBe("idle"); // no session — no-op

    session.start("DUKE");
    session.unconfirmed("Check the explorer.", HASH);
    expect(session.getSnapshot()).toMatchObject({ status: "unconfirmed", error: "Check the explorer.", hash: HASH });
  });

  it("dismiss() only takes effect once done or unconfirmed", () => {
    session.dismiss(); // idle already — no-op
    expect(session.getSnapshot().status).toBe("idle");

    session.start("DUKE");
    session.dismiss(); // still minting — no-op
    expect(session.getSnapshot().status).toBe("minting");

    session.finish(result);
    session.dismiss();
    expect(session.getSnapshot()).toEqual(initialMintSessionState);

    session.start("DUKE");
    session.unconfirmed("x", HASH);
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

  it("unconfirmed() removes the listener start() registered", () => {
    const target = fakeTarget();
    const s = createMintSession(target);
    s.start("DUKE");
    s.unconfirmed("x", HASH);
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
