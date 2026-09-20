import type { Address } from "@arcos/chain";
import type { DropResult } from "./runDrop";

/**
 * One send's progress: `step` is "approve" while waiting on an ERC-20 allowance, "send" while a batch
 * itself is in flight. `batch` is 1-based; it's `0` during "approve" since no batch has started yet.
 */
export type DropProgress = { batch: number; batches: number; step: "approve" | "send" };

export type DropSessionStatus = "idle" | "sending" | "done";

export type DropSessionState = {
  status: DropSessionStatus;
  /** Human-readable label for the progress UI ("USDC", or a real token's symbol) — captured once at
   * `start`, so a reopened window can say what's being sent without re-fetching token metadata. */
  tokenLabel: string;
  token: Address | null;
  decimals: number | null;
  progress: DropProgress | null;
  result: DropResult | null;
  /**
   * While `sending`: the exact text of the list this session is processing — nothing in it is confirmed
   * delivered yet, so the whole thing counts as "not yet sent". While `done`: recomputed to just the rows
   * still unsent, ready to prefill the form for a follow-up send.
   */
  remainingText: string;
  startedAt: number | null;
};

export const initialDropSessionState: DropSessionState = {
  status: "idle",
  tokenLabel: "",
  token: null,
  decimals: null,
  progress: null,
  result: null,
  remainingText: "",
  startedAt: null,
};

export type DropSessionAction =
  | { type: "start"; tokenLabel: string; token: Address | null; decimals: number; text: string; startedAt: number }
  | { type: "progress"; progress: DropProgress | null }
  | { type: "finish"; result: DropResult; remainingText: string }
  | { type: "dismiss" };

/**
 * Pure state machine for one Drop send session — no module state, no DOM, trivially unit-testable.
 *
 * `start` only applies from "idle" or "done"; from "sending" it's a no-op (returns `state` unchanged).
 * That no-op IS the hard guard against two concurrent sends, from any number of Drop windows or rapid
 * clicks on the same one — the store below turns it into the `false` return value callers check.
 * `finish` only applies from "sending"; `dismiss` only from "done". Every other combination is a no-op.
 */
export function dropSessionReducer(state: DropSessionState, action: DropSessionAction): DropSessionState {
  switch (action.type) {
    case "start":
      if (state.status === "sending") return state;
      return {
        status: "sending",
        tokenLabel: action.tokenLabel,
        token: action.token,
        decimals: action.decimals,
        progress: null,
        result: null,
        remainingText: action.text,
        startedAt: action.startedAt,
      };
    case "progress":
      return state.status === "sending" ? { ...state, progress: action.progress } : state;
    case "finish":
      return state.status === "sending"
        ? { ...state, status: "done", progress: null, result: action.result, remainingText: action.remainingText }
        : state;
    case "dismiss":
      return state.status === "done" ? { ...initialDropSessionState } : state;
  }
}

function beforeUnloadGuard(e: BeforeUnloadEvent): void {
  // Setting returnValue (and returning it) is what actually triggers the browser's native "leave site?"
  // prompt across engines; preventDefault alone isn't honored everywhere.
  e.preventDefault();
  e.returnValue = "";
}

/**
 * Module-level store: at most one Drop send session per page, independent of any single window's
 * lifetime. Closing a Drop window unmounts its React component (see packages/shell/src/core/reducer.ts's
 * "close"/"open" actions — a window's content only exists while it's in `state.windows`), which would
 * otherwise discard a send in progress along with any record that it ever happened. Keeping the session
 * here instead means the send loop keeps reporting into this store no matter what happens to the window
 * that started it, and any Drop window — the same one reopened, or a fresh one — picks it back up via
 * `getSnapshot`/`subscribe` instead of showing a blank form with no memory that money is or was in flight.
 */
let state: DropSessionState = initialDropSessionState;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function getSnapshot(): DropSessionState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Starts a session; refuses — returns `false`, changes nothing — if one is already sending. */
function start(tokenLabel: string, token: Address | null, decimals: number, text: string): boolean {
  if (state.status === "sending") return false;
  state = dropSessionReducer(state, { type: "start", tokenLabel, token, decimals, text, startedAt: Date.now() });
  if (typeof window !== "undefined") window.addEventListener("beforeunload", beforeUnloadGuard);
  emit();
  return true;
}

/** Reports progress; only takes effect while `sending` (a no-op otherwise, e.g. after `finish`). */
function setProgress(progress: DropProgress | null): void {
  const next = dropSessionReducer(state, { type: "progress", progress });
  if (next === state) return;
  state = next;
  emit();
}

/** Records the final result; only takes effect while `sending`. Removes the tab-close guard — the send is
 * over, so closing the tab can no longer orphan it. */
function finish(result: DropResult, remainingText: string): void {
  if (state.status !== "sending") return;
  state = dropSessionReducer(state, { type: "finish", result, remainingText });
  if (typeof window !== "undefined") window.removeEventListener("beforeunload", beforeUnloadGuard);
  emit();
}

/** Dismisses a finished session, returning to a blank form; only takes effect while `done`. */
function dismiss(): void {
  const next = dropSessionReducer(state, { type: "dismiss" });
  if (next === state) return;
  state = next;
  emit();
}

export const session = { getSnapshot, subscribe, start, setProgress, finish, dismiss };
