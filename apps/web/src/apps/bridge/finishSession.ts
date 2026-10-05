import type { Hex } from "viem";
import type { ChainId } from "./chains";

/**
 * One "Finish a transfer" at a time, held outside the component like the bridge session (session.ts) so closing the
 * window doesn't orphan a mint the wallet is being asked to sign. A finish is one wallet transaction, so this is the
 * small version of that machine: idle, working, done (with the mint's hash, or with the app's sentence for why not).
 */
export type FinishSessionState = {
  status: "idle" | "working" | "done";
  /** The burn being finished, while working or done. */
  burnTxHash: Hex | null;
  /** The destination chain, once the lookup named it. */
  dest: ChainId | null;
  /** Set when the mint was sent. */
  mintTxHash: Hex | null;
  /** Set instead of `mintTxHash` when the finish failed — never both at once. */
  error: string | null;
  /** Set with `status: "done"` and no mint when the chain says the transfer was already delivered. */
  alreadyDelivered: boolean;
};

export const initialFinishSessionState: FinishSessionState = {
  status: "idle",
  burnTxHash: null,
  dest: null,
  mintTxHash: null,
  error: null,
  alreadyDelivered: false,
};

export type FinishSessionAction =
  | { type: "start"; burnTxHash: Hex }
  | { type: "destination"; dest: ChainId }
  | { type: "minted"; mintTxHash: Hex }
  | { type: "delivered" }
  | { type: "fail"; message: string }
  | { type: "dismiss" };

export function finishSessionReducer(state: FinishSessionState, action: FinishSessionAction): FinishSessionState {
  switch (action.type) {
    case "start":
      if (state.status === "working") return state;
      return { ...initialFinishSessionState, status: "working", burnTxHash: action.burnTxHash };
    case "destination":
      return state.status === "working" ? { ...state, dest: action.dest } : state;
    case "minted":
      return state.status === "working" ? { ...state, status: "done", mintTxHash: action.mintTxHash, error: null } : state;
    case "delivered":
      return state.status === "working" ? { ...state, status: "done", alreadyDelivered: true, error: null } : state;
    case "fail":
      return state.status === "working" ? { ...state, status: "done", mintTxHash: null, error: action.message } : state;
    case "dismiss":
      return state.status === "done" ? initialFinishSessionState : state;
  }
}

export function createFinishSession() {
  let state = initialFinishSessionState;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const dispatch = (action: FinishSessionAction): boolean => {
    const next = finishSessionReducer(state, action);
    if (next === state) return false;
    state = next;
    emit();
    return true;
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** False, and nothing changes, when a finish is already working. */
    start: (burnTxHash: Hex) => dispatch({ type: "start", burnTxHash }),
    destination: (dest: ChainId) => dispatch({ type: "destination", dest }),
    minted: (mintTxHash: Hex) => dispatch({ type: "minted", mintTxHash }),
    delivered: () => dispatch({ type: "delivered" }),
    fail: (message: string) => dispatch({ type: "fail", message }),
    dismiss: () => dispatch({ type: "dismiss" }),
  };
}

export const finishSession = createFinishSession();
