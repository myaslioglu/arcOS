import type { Address } from "@arcos/chain";
import { formatDropList } from "./parse";
import { canDismissResult, type ExcludedRow } from "./result";
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
  /** Rows `parseDropList` rejected before this send began (bad address, bad amount, a duplicate,
   * ...) — captured once at `start` from the same parse that produced the rows actually sent, with
   * each row's ORIGINAL TEXT and reason, not just its line number: after a partial send replaces the
   * textarea with the unsent remainder, a line number alone would point at text the user can no
   * longer see anywhere (see ExcludedRow's doc comment). Lets the result panel say a send didn't
   * cover them, and show exactly what was excluded and why, instead of reading as "All delivered"
   * covering the whole list. */
  excludedRows: ExcludedRow[];
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
  excludedRows: [],
  startedAt: null,
};

export type DropSessionAction =
  | { type: "start"; tokenLabel: string; token: Address | null; decimals: number; text: string; excludedRows: ExcludedRow[]; startedAt: number }
  | { type: "progress"; progress: DropProgress | null }
  | { type: "finish"; result: DropResult; remainingText: string }
  | { type: "dismiss" }
  | { type: "dismissUnconfirmed" }
  | { type: "recoverUnconfirmed" };

/**
 * Pure state machine for one Drop send session — no module state, no DOM, trivially unit-testable.
 *
 * `start` only applies from "idle" or "done"; from "sending" it's a no-op (returns `state` unchanged).
 * That no-op IS the hard guard against two concurrent sends, from any number of Drop windows or rapid
 * clicks on the same one — the store below turns it into the `false` return value callers check.
 * `finish` only applies from "sending"; `dismiss` only from "done". Every other combination is a no-op.
 *
 * `start` and `dismiss` are ALSO no-ops while the current result holds an unresolved unconfirmed
 * batch (`canDismissResult`, wave H/G1): both replace `result`, and that batch's rows are in
 * `result.unconfirmed` and nowhere else — sending the remainder would silently erase them and the
 * hash that says whether they landed. One of the two buttons in the unconfirmed section has to
 * resolve it first.
 *
 * `dismissUnconfirmed`/`recoverUnconfirmed` (wave G, N1) only apply from "done" with a non-empty
 * `result.unconfirmed` — a batch `runDrop` reported as sent but not confirmed. Both clear
 * `result.unconfirmed` (so the section stops showing, including after the window is closed and
 * reopened), which is also what makes each one a no-op the second time it's applied: there's
 * nothing left to dismiss or recover, so `recoverUnconfirmed` can never move — or duplicate — the
 * same rows twice. `recoverUnconfirmed` additionally appends those rows, formatted exactly like the
 * rest of the list (`formatDropList`, at the session's own `token`/`decimals`), to `remainingText` —
 * the ONLY path back into the send list; `dismissUnconfirmed` ("it landed — I checked") discards
 * them instead, leaving `remainingText` untouched.
 */
export function dropSessionReducer(state: DropSessionState, action: DropSessionAction): DropSessionState {
  switch (action.type) {
    case "start":
      if (state.status === "sending" || !canDismissResult(state.result)) return state;
      return {
        status: "sending",
        tokenLabel: action.tokenLabel,
        token: action.token,
        decimals: action.decimals,
        progress: null,
        result: null,
        remainingText: action.text,
        excludedRows: action.excludedRows,
        startedAt: action.startedAt,
      };
    case "progress":
      return state.status === "sending" ? { ...state, progress: action.progress } : state;
    case "finish":
      return state.status === "sending"
        ? { ...state, status: "done", progress: null, result: action.result, remainingText: action.remainingText }
        : state;
    case "dismiss":
      return state.status === "done" && canDismissResult(state.result) ? { ...initialDropSessionState } : state;
    case "dismissUnconfirmed":
      if (state.status !== "done" || !state.result || state.result.unconfirmed.length === 0) return state;
      return { ...state, result: { ...state.result, unconfirmed: [] } };
    case "recoverUnconfirmed": {
      if (state.status !== "done" || !state.result || state.result.unconfirmed.length === 0) return state;
      // `decimals` is always a real number by "done" (it's required, non-null, on "start" — see
      // DropSessionAction above); the `?? 6` is only for TypeScript's benefit (the field's static
      // type is `number | null`, to cover the pre-send "idle" state).
      const appended = formatDropList(state.result.unconfirmed, state.token, state.decimals ?? 6);
      const remainingText = state.remainingText === "" ? appended : `${state.remainingText}\n${appended}`;
      // The rows are back in the list, so they belong in `remaining` too — the "N rows weren't
      // sent" banner counts that, and a banner that still named only the never-attempted rows
      // would undercount the list the user is now looking at. Clearing `unconfirmed` in the same
      // step is what keeps this from happening twice.
      const remaining = [...state.result.remaining, ...state.result.unconfirmed];
      return { ...state, remainingText, result: { ...state.result, remaining, unconfirmed: [] } };
    }
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

/** Starts a session; refuses — returns `false`, changes nothing — if one is already sending.
 * `excludedRows` defaults to empty for callers (and the many existing tests) that don't pass one. */
function start(tokenLabel: string, token: Address | null, decimals: number, text: string, excludedRows: ExcludedRow[] = []): boolean {
  if (state.status === "sending") return false;
  state = dropSessionReducer(state, { type: "start", tokenLabel, token, decimals, text, excludedRows, startedAt: Date.now() });
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

/** "It landed — I checked": clears an unconfirmed batch's rows from the result without touching
 * `remainingText` — the user has independently confirmed the send went through. A no-op once
 * there's nothing unconfirmed left (already dismissed, or recovered). */
function dismissUnconfirmed(): void {
  const next = dropSessionReducer(state, { type: "dismissUnconfirmed" });
  if (next === state) return;
  state = next;
  emit();
}

/** "It didn't land — put these rows back in the list": the ONLY way an unconfirmed batch's rows
 * re-enter the send list (see runDrop.ts's doc comment on why they're kept out of `remaining` in
 * the first place). Moves them into `remainingText` exactly once — calling this again, or after
 * `dismissUnconfirmed`, is a no-op, since `result.unconfirmed` is already empty by then. */
function recoverUnconfirmed(): void {
  const next = dropSessionReducer(state, { type: "recoverUnconfirmed" });
  if (next === state) return;
  state = next;
  emit();
}

export const session = { getSnapshot, subscribe, start, setProgress, finish, dismiss, dismissUnconfirmed, recoverUnconfirmed };
