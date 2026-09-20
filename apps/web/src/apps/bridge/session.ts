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
  startedAt: number | null;
};

export const initialBridgeSessionState: BridgeSessionState = {
  status: "idle",
  source: null,
  dest: null,
  amount: "",
  result: null,
  error: null,
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
      return { status: "bridging", source: action.source, dest: action.dest, amount: action.amount, result: null, error: null, startedAt: action.startedAt };
    case "finish":
      return state.status === "bridging" ? { ...state, status: "done", result: action.result, error: null } : state;
    case "fail":
      return state.status === "bridging" ? { ...state, status: "done", result: null, error: action.message } : state;
    case "dismiss":
      return state.status === "done" ? { ...initialBridgeSessionState } : state;
  }
}

function beforeUnloadGuard(e: BeforeUnloadEvent): void {
  e.preventDefault();
  e.returnValue = "";
}

/** Module-level store: at most one Bridge session per page, independent of any single window's
 * lifetime — see apps/drop/session.ts for the full rationale. */
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
  if (typeof window !== "undefined") window.addEventListener("beforeunload", beforeUnloadGuard);
  emit();
  return true;
}

function finish(result: BridgeResult): void {
  if (state.status !== "bridging") return;
  state = bridgeSessionReducer(state, { type: "finish", result });
  if (typeof window !== "undefined") window.removeEventListener("beforeunload", beforeUnloadGuard);
  emit();
}

function fail(message: string): void {
  if (state.status !== "bridging") return;
  state = bridgeSessionReducer(state, { type: "fail", message });
  if (typeof window !== "undefined") window.removeEventListener("beforeunload", beforeUnloadGuard);
  emit();
}

function dismiss(): void {
  const next = bridgeSessionReducer(state, { type: "dismiss" });
  if (next === state) return;
  state = next;
  emit();
}

export const session = { getSnapshot, subscribe, start, finish, fail, dismiss };
