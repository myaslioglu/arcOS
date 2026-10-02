import { afterEach, describe, expect, it, vi } from "vitest";
import { BalanceError, KitError, RateLimitError, type BridgeResult } from "@circle-fin/app-kit";
import { GENERIC_TRANSACTION_ERROR } from "@/lib/contract-error";
import { EMBEDDED_FRAME_MESSAGE } from "@/lib/wallet-frame";
import {
  bridgeSessionReducer,
  classifyBridgeFailure,
  describeStepError,
  describeWarning,
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

// What Bridge's submit catch shows, pulled out of Window.tsx like Swap's classifySwapFailure.
describe("classifyBridgeFailure", () => {
  const NOTE = "Check the source chain's explorer before trying again.";
  const TEXT = "Request blocked: embedded frames are not allowed for this origin. For your security, 4rcos.com can't make this request from an embedded frame.";

  it("says to reload when the wallet took the page for an embedded frame: it refused the first request, so nothing was sent", () => {
    expect(classifyBridgeFailure(new Error(TEXT), NOTE)).toBe(EMBEDDED_FRAME_MESSAGE);
    expect(classifyBridgeFailure(new Error("Bridge failed", { cause: { trace: { originalError: new Error(TEXT) } } }), NOTE)).toBe(EMBEDDED_FRAME_MESSAGE);
  });

  it("keeps its sentences for a cancellation, a rate limit and anything else", () => {
    expect(classifyBridgeFailure(new Error("User rejected the request"), NOTE)).toBe("Cancelled.");
    const busy = new KitError({ ...RateLimitError.RATE_LIMIT_EXCEEDED, recoverability: "RETRYABLE", message: "Rate limit exceeded, please retry later" });
    expect(classifyBridgeFailure(busy, NOTE)).toBe(`The bridge service is busy. Try again in a minute. ${NOTE}`);
    const raw = classifyBridgeFailure(new Error("raw detail: https://internal.example/x"), NOTE);
    expect(raw).toBe(`${GENERIC_TRANSACTION_ERROR} ${NOTE}`);
    expect(raw).not.toMatch(/internal\.example/);
  });

  // The live site's "Bridge fails at once": with the window's defaults (To Arc, from Ethereum) and no USDC on Ethereum,
  // App Kit's pre-flight balance check throws this before the wallet is asked for anything (reproduced against Arc
  // mainnet with a stand-in wallet), and the window showed only the generic sentence.
  it("names the chain when App Kit finds too little USDC on the source chain, in the app's own words", () => {
    const short = new KitError({
      ...BalanceError.INSUFFICIENT_TOKEN,
      recoverability: "FATAL",
      message: "Insufficient USDC balance on Ethereum",
      cause: { trace: { balance: "0", amount: "1002000", chain: "Ethereum", token: "USDC" } },
    });
    const text = classifyBridgeFailure(short, NOTE, { label: "Ethereum", gasSymbol: "ETH" });
    expect(text).toBe("Your wallet doesn't have enough USDC on Ethereum for this amount and the fee. Pick the chain that holds your USDC, or lower the amount.");
    expect(text).not.toContain("Insufficient");
  });

  it("names the gas token when the source chain has too little of it", () => {
    const noGas = new KitError({ ...BalanceError.INSUFFICIENT_GAS, recoverability: "FATAL", message: "Insufficient native token on Polygon to cover gas fees" });
    expect(classifyBridgeFailure(noGas, NOTE, { label: "Polygon", gasSymbol: "POL" })).toBe(
      "Your wallet doesn't have enough POL on Polygon to pay for gas. Add some POL there and try again.",
    );
  });

  it("keeps the generic sentence for a balance error when no source is given, and for an allowance shortfall", () => {
    const short = new KitError({ ...BalanceError.INSUFFICIENT_TOKEN, recoverability: "FATAL", message: "Insufficient USDC balance on Base" });
    expect(classifyBridgeFailure(short, NOTE)).toBe(`${GENERIC_TRANSACTION_ERROR} ${NOTE}`);
    const allowance = new KitError({ ...BalanceError.INSUFFICIENT_ALLOWANCE, recoverability: "FATAL", message: "Insufficient allowance" });
    expect(classifyBridgeFailure(allowance, NOTE, { label: "Base", gasSymbol: "ETH" })).toBe(`${GENERIC_TRANSACTION_ERROR} ${NOTE}`);
  });
});

// What a finished bridge's step list says for a failed step: the app's sentences, never the SDK's text.
describe("describeStepError", () => {
  const ARC = { label: "Arc", gasSymbol: "USDC" };
  const RAW = "User rejected the request. Request Arguments: chain: Arc (id: 5042) from: 0x463A81a017326E9029DcCA2a2d9AA42599Bef12c to: 0x3600000000000000000000000000000000000000";

  /** The step App Kit records when the wallet rejects an approval: its own error wraps viem's, which carries code 4001. */
  const rejected = () => ({
    errorMessage: `Unknown blockchain error on Arc: ${RAW}`,
    error: {
      code: 5099,
      name: "ONCHAIN_UNKNOWN_BLOCKCHAIN_ERROR",
      message: `Unknown blockchain error on Arc: ${RAW}`,
      cause: { trace: { chain: "Arc", rawError: { rawError: { shortMessage: "User rejected the request.", message: RAW, cause: { shortMessage: "User rejected the request.", code: 4001, name: "UserRejectedRequestError" } } } } },
    },
  });

  it("says a rejection in the wallet in the app's words, with no address and no request arguments", () => {
    const line = describeStepError(rejected(), ARC);
    expect(line).toBe("Rejected in your wallet.");
    expect(line).not.toMatch(/0x/);
    expect(line).not.toMatch(/Request Arguments/i);
  });

  it("reads the raw message alone the same way, when the step carries no error object", () => {
    const line = describeStepError({ errorMessage: RAW }, ARC);
    expect(line).toBe("Rejected in your wallet.");
    expect(line).not.toMatch(/0x|Request Arguments/i);
  });

  it("says the wallet didn't switch chains, before reading the rejection inside that failure", () => {
    const err = { code: 5099, name: "ONCHAIN_UNKNOWN_BLOCKCHAIN_ERROR", message: "Unknown blockchain error on Base", cause: { trace: { rawError: new Error("Failed to switch to chain Base (ID: 8453): User rejected the request. Ensure the chain is supported by your wallet or provider.") } } };
    expect(describeStepError({ error: err }, { label: "Base", gasSymbol: "ETH" })).toBe("Your wallet didn't switch to Base.");
    expect(describeStepError({ error: { code: 4902, message: "Unrecognized chain ID" } }, { label: "Base", gasSymbol: "ETH" })).toBe("Your wallet didn't switch to Base.");
  });

  it("names the chain for too little USDC, and the gas token for too little gas", () => {
    const short = new KitError({ ...BalanceError.INSUFFICIENT_TOKEN, recoverability: "FATAL", message: "Insufficient USDC balance on Arc" });
    expect(describeStepError({ error: short }, ARC)).toMatch(/^Your wallet doesn't have enough USDC on Arc/);
    const noGas = new KitError({ ...BalanceError.INSUFFICIENT_GAS, recoverability: "FATAL", message: "Insufficient native token on Base to cover gas fees" });
    expect(describeStepError({ error: noGas }, { label: "Base", gasSymbol: "ETH" })).toMatch(/^Your wallet doesn't have enough ETH on Base/);
  });

  it("trusts the SDK's own classification first: errorCategory 'user_rejected' needs no error object at all", () => {
    expect(describeStepError({ errorCategory: "user_rejected", errorMessage: "execution reverted" }, ARC)).toBe("Rejected in your wallet.");
  });

  it("never throws during render: a getter that throws on code, message or type reads as the generic sentence", () => {
    const hostile = {
      get code(): number { throw new Error("no"); },
      get message(): string { throw new Error("no"); },
      get type(): string { throw new Error("no"); },
    };
    expect(describeStepError({ error: hostile, errorMessage: "x" }, ARC)).toBe("This step didn't finish.");
    expect(describeStepError({ error: { cause: { get trace(): unknown { throw new Error("no"); } } } }, ARC)).toBe("This step didn't finish.");
  });

  it("keeps one generic sentence for anything else, never the error's own text", () => {
    const line = describeStepError({ error: new Error("execution reverted: https://internal.example/x 0xdeadbeef"), errorMessage: "execution reverted 0xdeadbeef" }, ARC);
    expect(line).toBe("This step didn't finish.");
    const loop: { cause?: unknown; message: string } = { message: "loop" };
    loop.cause = loop;
    expect(describeStepError({ error: loop }, ARC)).toBe("This step didn't finish.");
  });
});

// What a BridgeResult's warnings say: by code, never the SDK's own message.
describe("describeWarning", () => {
  it("words the two codes the installed App Kit defines", () => {
    expect(describeWarning({ code: "SPEED_DOWNGRADED" })).toMatch(/slower route/);
    expect(describeWarning({ code: "QUOTE_NOT_REUSED" })).toMatch(/fee paid may differ/);
  });

  it("gives any other code one generic sentence, and never the message", () => {
    const line = describeWarning({ code: "SOMETHING_NEW", message: "Fee recipient 0x463A81a017326E9029DcCA2a2d9AA42599Bef12c rejected" } as { code: string });
    expect(line).toBe("The bridge reported a warning.");
    expect(line).not.toMatch(/0x/);
    expect(describeWarning({ get code(): string { throw new Error("no"); } })).toBe("The bridge reported a warning.");
  });
});
