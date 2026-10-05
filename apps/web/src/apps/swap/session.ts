import { isRateLimitError, type SwapResult } from "@circle-fin/app-kit";
import { isKitCancellation } from "@/lib/kit-errors";
import { EMBEDDED_FRAME_MESSAGE, isEmbeddedFrameRefusal } from "@/lib/wallet-frame";
import type { SwapToken } from "./tokenPair";

/**
 * "stopped" is the visitor's own "Stop waiting" while the wallet hadn't answered: the outcome is unknown, so it holds
 * neither a result nor an error, and the form is usable again (only "swapping" locks it).
 */
export type SwapSessionStatus = "idle" | "swapping" | "stopped" | "done";

export type SwapSessionState = {
  status: SwapSessionStatus;
  tokenIn: SwapToken | null;
  tokenOut: SwapToken | null;
  amountIn: string;
  result: SwapResult | null;
  /** Set instead of `result` when the swap failed — never both at once. */
  error: string | null;
  startedAt: number | null;
  /** Which `start` this state belongs to; 0 before the first one. `finish`/`fail` name the run they answer, so a
   * promise that settles after the visitor stopped waiting, or after a newer swap began, can't overwrite it. */
  runId: number;
};

export const initialSwapSessionState: SwapSessionState = {
  status: "idle",
  tokenIn: null,
  tokenOut: null,
  amountIn: "",
  result: null,
  error: null,
  startedAt: null,
  runId: 0,
};

export type SwapSessionAction =
  | { type: "start"; tokenIn: SwapToken; tokenOut: SwapToken; amountIn: string; startedAt: number; runId: number }
  | { type: "finish"; result: SwapResult; runId: number }
  | { type: "fail"; message: string; runId: number }
  | { type: "stop"; runId: number }
  | { type: "dismiss" };

/** Whether the form is locked: only while a run is swapping. A stopped run frees it, with its outcome unknown. */
export function locksForm(state: Pick<SwapSessionState, "status">): boolean {
  return state.status === "swapping";
}

/** The run `finish`/`fail` may still answer: the one swapping now, or the one the visitor stopped waiting for (its
 * real outcome, arriving late, replaces "unknown"). Any other run is stale and changes nothing. */
function answers(state: SwapSessionState, runId: number): boolean {
  return state.runId === runId && (state.status === "swapping" || state.status === "stopped");
}

/**
 * Pure state machine for one Swap session — mirrors apps/drop/session.ts's dropSessionReducer.
 * `start` only applies from "idle", "stopped" or "done" (a no-op from "swapping" is the hard guard against a
 * second concurrent swap, from any number of windows or clicks). `finish`/`fail` only apply to their own run, while
 * it is swapping or stopped (see `answers`); `stop` only to the run swapping now; `dismiss` only from "stopped" or
 * "done".
 */
export function swapSessionReducer(state: SwapSessionState, action: SwapSessionAction): SwapSessionState {
  switch (action.type) {
    case "start":
      if (state.status === "swapping") return state;
      return {
        status: "swapping",
        tokenIn: action.tokenIn,
        tokenOut: action.tokenOut,
        amountIn: action.amountIn,
        result: null,
        error: null,
        startedAt: action.startedAt,
        runId: action.runId,
      };
    case "finish":
      return answers(state, action.runId) ? { ...state, status: "done", result: action.result, error: null } : state;
    case "fail":
      return answers(state, action.runId) ? { ...state, status: "done", result: null, error: action.message } : state;
    case "stop":
      return state.status === "swapping" && state.runId === action.runId ? { ...state, status: "stopped", result: null, error: null } : state;
    case "dismiss":
      return state.status === "done" || state.status === "stopped" ? { ...initialSwapSessionState } : state;
  }
}

/**
 * Decides what Swap's submit catch-all should show — pulled out as a pure function (mirrors Mint's
 * `classifyMintFailure`, apps/mint/session.ts) so it's unit-tested without a live wallet/RPC/SDK.
 *
 * A cancellation is a definite, pre-broadcast failure: `isKitCancellation` (lib/kit-errors.ts: the kit's
 * `isUserCancellationError`, minus its code-4001 collision with the kit's own RPC endpoint error) fires
 * before any signature is sent, so it keeps its own plain sentence. A rate limit is Circle's API throttling, but
 * `kit.swap()` also talks to that API after the wallet sends (it follows the swap's progress), so a
 * rate limit can come after a broadcast: it says the service is busy and hedges like the unknown case.
 *
 * Anything else is a genuine unknown: `kit.swap()` is one opaque promise with no `onProgress`/hash
 * signal before it settles (unlike Mint's `writeContractAsync`, which hands back a hash synchronously
 * in Window.tsx — see `classifyMintFailure`'s `hashKnown`), so a rejection here could just as easily
 * follow a lost wallet response or a timeout AFTER the swap was actually broadcast as it could precede
 * one. Saying "Try again" alone would read as "nothing happened" and could invite a second,
 * separately-charged swap — this hedges instead, mirroring Bridge's identical reasoning
 * (bridge/session.ts's `classifyBridgeFailure`, bridge/inFlight.ts's `explorerCheckNote`) adapted for
 * Swap, which has no per-attempt explorer link to offer at this point (only a successful `SwapResult`
 * carries one).
 * Never the underlying error's own text, same rule as every other wallet/RPC/SDK error this app shows.
 *
 * A wallet that took the page for an embedded frame is checked first: it refuses the first request, so nothing was
 * sent, and only a reload helps (lib/wallet-frame.ts).
 */
export function classifySwapFailure(err: unknown): string {
  if (isEmbeddedFrameRefusal(err)) return EMBEDDED_FRAME_MESSAGE;
  if (isKitCancellation(err)) return "Cancelled.";
  if (isRateLimitError(err)) return "The swap service is busy, and the swap may still have gone through. Check your wallet's activity before trying again in a minute.";
  return "The swap didn't finish. It may still have gone through, so check your wallet's activity before trying again.";
}

/** The slice of `window` the beforeunload guard needs — narrowed so tests can inject a minimal fake
 * instead of depending on jsdom (this workspace's vitest runs `environment: "node"` unless a file opts
 * into jsdom, so there's no real `window` to exercise this against otherwise). */
export type BeforeUnloadTarget = {
  addEventListener(type: "beforeunload", listener: (e: BeforeUnloadEvent) => void): void;
  removeEventListener(type: "beforeunload", listener: (e: BeforeUnloadEvent) => void): void;
};

function beforeUnloadGuard(e: BeforeUnloadEvent): void {
  e.preventDefault();
  e.returnValue = "";
}

/**
 * Factory behind the module-level `session` singleton below, pulled out so tests can construct an
 * isolated instance against a fake `BeforeUnloadTarget` instead of the real `window`.
 * The production singleton is the one export that matters at runtime: at most one Swap session per
 * page, independent of any single window's lifetime — see apps/drop/session.ts for the full
 * rationale (closing the window unmounts the form, which must not orphan a signed transaction the
 * chain is still confirming).
 *
 * `target` defaults to the real `window` when one exists and `undefined` otherwise (SSR / this
 * workspace's node test environment) — re-resolved on every call, exactly matching the previous
 * inline `typeof window !== "undefined"` guard.
 */
export function createSwapSession(target?: BeforeUnloadTarget) {
  const resolveTarget = (): BeforeUnloadTarget | undefined => target ?? (typeof window === "undefined" ? undefined : window);

  let state: SwapSessionState = initialSwapSessionState;
  let lastRunId = 0;
  const listeners = new Set<() => void>();

  function emit(): void {
    for (const listener of listeners) listener();
  }

  function getSnapshot(): SwapSessionState {
    return state;
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** Starts a session and returns its run id, which `finish`/`fail`/`stop` take; refuses — returns `null`, changes
   * nothing — if one is already swapping. */
  function start(tokenIn: SwapToken, tokenOut: SwapToken, amountIn: string): number | null {
    if (state.status === "swapping") return null;
    const runId = ++lastRunId;
    state = swapSessionReducer(state, { type: "start", tokenIn, tokenOut, amountIn, startedAt: Date.now(), runId });
    resolveTarget()?.addEventListener("beforeunload", beforeUnloadGuard);
    emit();
    return runId;
  }

  /** Applies `action` if it changes anything; returns whether it did. */
  function apply(action: SwapSessionAction): boolean {
    const next = swapSessionReducer(state, action);
    if (next === state) return false;
    const wasSwapping = state.status === "swapping";
    state = next;
    if (wasSwapping) resolveTarget()?.removeEventListener("beforeunload", beforeUnloadGuard);
    emit();
    return true;
  }

  /** Records run `runId`'s result; ignored for any run but the one swapping or stopped now. */
  function finish(result: SwapResult, runId: number): boolean {
    return apply({ type: "finish", result, runId });
  }

  /** Records run `runId`'s failure; ignored for any run but the one swapping or stopped now. */
  function fail(message: string, runId: number): boolean {
    return apply({ type: "fail", message, runId });
  }

  /**
   * The visitor's "Stop waiting": run `runId` stops holding the form, its outcome unknown. Nothing is cancelled — the
   * wallet may still send the swap — and the run's promise may still settle into this state (see `answers`).
   */
  function stop(runId: number): boolean {
    return apply({ type: "stop", runId });
  }

  /** Dismisses a finished or stopped session, returning to a blank form. */
  function dismiss(): void {
    const next = swapSessionReducer(state, { type: "dismiss" });
    if (next === state) return;
    state = next;
    emit();
  }

  return { getSnapshot, subscribe, start, finish, fail, stop, dismiss };
}

export const session = createSwapSession();

/**
 * What the window says once the visitor stops waiting: the outcome is unknown, so it says neither "failed" nor "try
 * again" — a swap the wallet already sent still completes, and a request still open in the wallet can still be signed.
 */
export const STOPPED_WAITING_MESSAGE =
  "Stopped waiting. The outcome is unknown: if your wallet already sent the swap, it will still complete, and a request still open in your wallet can still be signed, so reject it there if you don't want it. Check your balance or your address in the explorer before you swap again, so you don't swap twice.";

/** Shown while the wallet hasn't answered for a while (lib/wallet-wait.ts). */
export const WALLET_WAIT_MESSAGE =
  "Still waiting on your wallet. Check your wallet app for a request to approve or sign; on a phone, open the wallet app.";
