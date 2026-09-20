import type { SwapResult } from "@circle-fin/app-kit";
import type { SwapToken } from "./tokenPair";

export type SwapSessionStatus = "idle" | "swapping" | "done";

export type SwapSessionState = {
  status: SwapSessionStatus;
  tokenIn: SwapToken | null;
  tokenOut: SwapToken | null;
  amountIn: string;
  result: SwapResult | null;
  /** Set instead of `result` when the swap failed — never both at once. */
  error: string | null;
  startedAt: number | null;
};

export const initialSwapSessionState: SwapSessionState = {
  status: "idle",
  tokenIn: null,
  tokenOut: null,
  amountIn: "",
  result: null,
  error: null,
  startedAt: null,
};

export type SwapSessionAction =
  | { type: "start"; tokenIn: SwapToken; tokenOut: SwapToken; amountIn: string; startedAt: number }
  | { type: "finish"; result: SwapResult }
  | { type: "fail"; message: string }
  | { type: "dismiss" };

/**
 * Pure state machine for one Swap session — mirrors apps/drop/session.ts's dropSessionReducer.
 * `start` only applies from "idle" or "done" (a no-op from "swapping" is the hard guard against a
 * second concurrent swap, from any number of windows or clicks). `finish`/`fail` only apply from
 * "swapping"; `dismiss` only from "done".
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
      };
    case "finish":
      return state.status === "swapping" ? { ...state, status: "done", result: action.result, error: null } : state;
    case "fail":
      return state.status === "swapping" ? { ...state, status: "done", result: null, error: action.message } : state;
    case "dismiss":
      return state.status === "done" ? { ...initialSwapSessionState } : state;
  }
}

/** The slice of `window` the beforeunload guard needs — narrowed so tests can inject a minimal fake
 * instead of depending on jsdom (this workspace's vitest runs `environment: "node"`, so there's no
 * real `window` to exercise this against otherwise). */
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
 * isolated instance against a fake `BeforeUnloadTarget` instead of the real (jsdom-only) `window`.
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

  /** Starts a session; refuses — returns `false`, changes nothing — if one is already swapping. */
  function start(tokenIn: SwapToken, tokenOut: SwapToken, amountIn: string): boolean {
    if (state.status === "swapping") return false;
    state = swapSessionReducer(state, { type: "start", tokenIn, tokenOut, amountIn, startedAt: Date.now() });
    resolveTarget()?.addEventListener("beforeunload", beforeUnloadGuard);
    emit();
    return true;
  }

  /** Records a successful result; only takes effect while swapping. */
  function finish(result: SwapResult): void {
    if (state.status !== "swapping") return;
    state = swapSessionReducer(state, { type: "finish", result });
    resolveTarget()?.removeEventListener("beforeunload", beforeUnloadGuard);
    emit();
  }

  /** Records a failure; only takes effect while swapping. */
  function fail(message: string): void {
    if (state.status !== "swapping") return;
    state = swapSessionReducer(state, { type: "fail", message });
    resolveTarget()?.removeEventListener("beforeunload", beforeUnloadGuard);
    emit();
  }

  /** Dismisses a finished session, returning to a blank form; only takes effect while done. */
  function dismiss(): void {
    const next = swapSessionReducer(state, { type: "dismiss" });
    if (next === state) return;
    state = next;
    emit();
  }

  return { getSnapshot, subscribe, start, finish, fail, dismiss };
}

export const session = createSwapSession();
