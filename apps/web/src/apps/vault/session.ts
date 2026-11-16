import type { ActionOutcome, LockOutcome, LockStep, VaultAction } from "./flow";

/**
 * Module-level store: Vault's transactions in flight, independent of any window's lifetime, as Mint's and Revoke's are
 * (mint/session.ts, revoke/session.ts). Closing the window unmounts its component, which would otherwise lose a lock
 * in flight with its hash: a reopened window would show a blank form and invite a second, separately charged lock.
 * One wallet transaction at a time, page-wide: a lock or an action on one vault.
 */

/** What a lock is of, for the progress and the result: "1,000 VTA" or "Uniswap v4 #328647", and until when. */
export type LockSummary = { label: string; unlockAt: number; kind: "token" | "position" };

export type LockRun =
  | { status: "idle" }
  | { status: "running"; summary: LockSummary; step: LockStep; sent: boolean }
  | { status: "done"; summary: LockSummary; outcome: LockOutcome };

export type ActionKind = VaultAction["kind"];
export type ActionRun = { vault: string; kind: ActionKind; sent: boolean };
/** What the last action on a vault came to, shown on its row until dismissed or replaced. */
export type ActionNote = { kind: ActionKind; outcome: ActionOutcome; detail?: string };

export type VaultSessionState = {
  lock: LockRun;
  action: ActionRun | null;
  /** By vault address, lowercased. */
  notes: Readonly<Record<string, ActionNote>>;
};

const initial: VaultSessionState = { lock: { status: "idle" }, action: null, notes: {} };
let state: VaultSessionState = initial;
const listeners = new Set<() => void>();

/** `notes` without `key`. */
const without = (notes: Readonly<Record<string, ActionNote>>, key: string) => Object.fromEntries(Object.entries(notes).filter(([k]) => k !== key));

function set(next: VaultSessionState): void {
  state = next;
  for (const listener of listeners) listener();
}

function getSnapshot(): VaultSessionState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True while a wallet transaction is under way, from any Vault window. */
export function isBusy(s: VaultSessionState): boolean {
  return s.lock.status === "running" || s.action !== null;
}

function beforeUnloadGuard(e: BeforeUnloadEvent): void {
  e.preventDefault();
  e.returnValue = "";
}

function guard(on: boolean): void {
  if (typeof window === "undefined") return;
  if (on) window.addEventListener("beforeunload", beforeUnloadGuard);
  else window.removeEventListener("beforeunload", beforeUnloadGuard);
}

/**
 * Runs one lock through `execute` (flow.ts's `runLock`, handed the step callback), and keeps its outcome until
 * dismissed. Refuses, returning null and changing nothing, while any Vault transaction is under way.
 */
function startLock(
  summary: LockSummary,
  execute: (onStep: (step: LockStep, sent: boolean) => void) => Promise<LockOutcome>,
): Promise<LockOutcome> | null {
  if (isBusy(state)) return null;
  set({ ...state, lock: { status: "running", summary, step: "lock", sent: false } });
  guard(true);
  const onStep = (step: LockStep, sent: boolean) => {
    if (state.lock.status === "running") set({ ...state, lock: { ...state.lock, step, sent } });
  };
  return (async () => {
    let outcome: LockOutcome;
    try {
      outcome = await execute(onStep);
    } catch {
      // runLock reports its own failures; this is only for one that throws anyway.
      outcome = { result: "failed", message: "Something went wrong. Check Your locks before you try again.", approvalLeft: false };
    } finally {
      guard(false);
    }
    set({ ...state, lock: { status: "done", summary, outcome } });
    return outcome;
  })();
}

/** Clears a finished lock, so the form shows again. Does nothing while one runs. */
function dismissLock(): void {
  if (state.lock.status === "done") set({ ...state, lock: { status: "idle" } });
}

/**
 * Runs one action on `vault` through `execute` (flow.ts's `runAction`, handed the "sent" callback) and keeps its
 * outcome on that vault's row. `detail` turns the outcome into the row's sentence. Refuses, returning null, while any
 * Vault transaction is under way.
 */
function startAction(
  vault: string,
  kind: ActionKind,
  execute: (onSent: () => void) => Promise<ActionOutcome>,
  detail?: (outcome: ActionOutcome) => string | undefined,
): Promise<ActionOutcome> | null {
  if (isBusy(state)) return null;
  const key = vault.toLowerCase();
  set({ ...state, action: { vault: key, kind, sent: false }, notes: without(state.notes, key) });
  guard(true);
  return (async () => {
    let outcome: ActionOutcome;
    try {
      outcome = await execute(() => {
        if (state.action?.vault === key) set({ ...state, action: { ...state.action, sent: true } });
      });
    } catch {
      outcome = { result: "failed", message: "Something went wrong. Check the vault before you try again." };
    } finally {
      guard(false);
    }
    set({ ...state, action: null, notes: { ...state.notes, [key]: { kind, outcome, detail: detail?.(outcome) } } });
    return outcome;
  })();
}

function dismissNote(vault: string): void {
  const key = vault.toLowerCase();
  if (!(key in state.notes)) return;
  set({ ...state, notes: without(state.notes, key) });
}

/** Forgets everything (for tests). */
function forget(): void {
  guard(false);
  set(initial);
}

export const vaultSession = { getSnapshot, subscribe, startLock, dismissLock, startAction, dismissNote, forget };
