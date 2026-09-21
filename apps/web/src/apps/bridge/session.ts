import type { BridgeResult } from "@circle-fin/app-kit";
import type { ChainId } from "./chains";

export type BridgeSessionStatus = "idle" | "bridging" | "done";

export type BridgeSessionState = {
  status: BridgeSessionStatus;
  source: ChainId | null;
  dest: ChainId | null;
  amount: string;
  result: BridgeResult | null;
  /** Set instead of `result` when the bridge failed — never both at once. */
  error: string | null;
  /**
   * The most recent non-null `BridgeResult` — including one whose own `state` is `"error"` — kept
   * across a `start()` (which resets `result` to `null` the instant a retry begins) and across a
   * `fail()` (a thrown error has no `BridgeResult` of its own to report). Without this, `result`
   * alone loses the first attempt's burn tx hash and step list the moment a retry starts, and loses
   * it for good if that retry itself throws — this is what lets the window keep showing the original
   * evidence, and the "funds are in flight" explanation, throughout a retry. Cleared only on dismiss.
   */
  lastResult: BridgeResult | null;
  startedAt: number | null;
};

export const initialBridgeSessionState: BridgeSessionState = {
  status: "idle",
  source: null,
  dest: null,
  amount: "",
  result: null,
  error: null,
  lastResult: null,
  startedAt: null,
};

export type BridgeSessionAction =
  | { type: "start"; source: ChainId; dest: ChainId; amount: string; startedAt: number }
  | { type: "finish"; result: BridgeResult }
  | { type: "fail"; message: string }
  | { type: "dismiss" };

/**
 * Pure state machine for one Bridge session — mirrors apps/drop/session.ts and
 * apps/swap/session.ts. A bridge can run for minutes (CCTP attestation plus, when it isn't
 * forwarded, a second wallet-signed mint on the destination chain), so holding this outside the
 * component matters even more here than for Swap: closing the window must not orphan a transfer
 * that's already burned funds on the source chain.
 */
export function bridgeSessionReducer(state: BridgeSessionState, action: BridgeSessionAction): BridgeSessionState {
  switch (action.type) {
    case "start":
      if (state.status === "bridging") return state;
      return {
        status: "bridging",
        source: action.source,
        dest: action.dest,
        amount: action.amount,
        result: null,
        error: null,
        lastResult: state.lastResult,
        startedAt: action.startedAt,
      };
    case "finish":
      return state.status === "bridging" ? { ...state, status: "done", result: action.result, error: null, lastResult: action.result } : state;
    case "fail":
      return state.status === "bridging" ? { ...state, status: "done", result: null, error: action.message } : state;
    case "dismiss":
      return state.status === "done" ? { ...initialBridgeSessionState } : state;
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
 * The production singleton is the one export that matters at runtime: at most one Bridge session
 * per page, independent of any single window's lifetime — see apps/drop/session.ts for the full
 * rationale.
 *
 * `target` defaults to the real `window` when one exists and `undefined` otherwise (SSR / this
 * workspace's node test environment) — re-resolved on every call, exactly matching the previous
 * inline `typeof window !== "undefined"` guard.
 */
export function createBridgeSession(target?: BeforeUnloadTarget) {
  const resolveTarget = (): BeforeUnloadTarget | undefined => target ?? (typeof window === "undefined" ? undefined : window);

  let state: BridgeSessionState = initialBridgeSessionState;
  const listeners = new Set<() => void>();

  function emit(): void {
    for (const listener of listeners) listener();
  }

  function getSnapshot(): BridgeSessionState {
    return state;
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** Starts a session; refuses — returns `false`, changes nothing — if one is already bridging. */
  function start(source: ChainId, dest: ChainId, amount: string): boolean {
    if (state.status === "bridging") return false;
    state = bridgeSessionReducer(state, { type: "start", source, dest, amount, startedAt: Date.now() });
    resolveTarget()?.addEventListener("beforeunload", beforeUnloadGuard);
    emit();
    return true;
  }

  function finish(result: BridgeResult): void {
    if (state.status !== "bridging") return;
    state = bridgeSessionReducer(state, { type: "finish", result });
    resolveTarget()?.removeEventListener("beforeunload", beforeUnloadGuard);
    emit();
  }

  function fail(message: string): void {
    if (state.status !== "bridging") return;
    state = bridgeSessionReducer(state, { type: "fail", message });
    resolveTarget()?.removeEventListener("beforeunload", beforeUnloadGuard);
    emit();
  }

  function dismiss(): void {
    const next = bridgeSessionReducer(state, { type: "dismiss" });
    if (next === state) return;
    state = next;
    emit();
  }

  return { getSnapshot, subscribe, start, finish, fail, dismiss };
}

export const session = createBridgeSession();
