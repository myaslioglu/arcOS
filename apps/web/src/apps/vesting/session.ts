import type { Address } from "@arcos/chain";
import type { DropRow } from "@/lib/recipient-list";
import type { FormState, Terms } from "./form";
import type { RowState, VestingRunResult } from "./runVesting";

/**
 * The bulk run, kept outside the window so it survives the window closing mid-run (a reopened window shows the run, not
 * a blank form that would invite creating the schedules twice). One run at a time.
 */
export type VestingSession =
  | { status: "idle" }
  | {
      status: "running" | "done";
      token: Address;
      symbol: string;
      decimals: number;
      rows: DropRow[];
      /** What the run was started with, in full: a retry of the unfinished rows must use the same terms, not the form's defaults. */
      form: FormState;
      terms: Terms;
      states: RowState[];
      /** "approve" while the allowance is being set; "create" while schedules are being made. */
      step: "approve" | "create";
      /** What the factory may still take from the wallet when the run ended (the approval minus what was spent), or null if unknown. */
      leftoverAllowance: bigint | null;
      result: VestingRunResult | null;
      /** A sentence about the approval step, when it failed. */
      approvalMessage: string | null;
      startedAt: number;
    };

let state: VestingSession = { status: "idle" };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

const beforeUnloadGuard = (e: BeforeUnloadEvent) => {
  e.preventDefault();
};

const getSnapshot = (): VestingSession => state;
const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

/** Starts a run; false when one is already going. */
function start(token: Address, symbol: string, decimals: number, rows: DropRow[], form: FormState, terms: Terms): boolean {
  if (state.status === "running") return false;
  state = {
    status: "running",
    token,
    symbol,
    decimals,
    rows,
    form,
    terms,
    states: rows.map(() => ({ status: "waiting" })),
    step: "approve",
    leftoverAllowance: null,
    result: null,
    approvalMessage: null,
    startedAt: Date.now(),
  };
  if (typeof window !== "undefined") window.addEventListener("beforeunload", beforeUnloadGuard);
  emit();
  return true;
}

function update(patch: Partial<Extract<VestingSession, { status: "running" | "done" }>>): void {
  if (state.status === "idle") return;
  state = { ...state, ...patch };
  emit();
}

function setStates(states: readonly RowState[]): void {
  update({ states: [...states] });
}

function finish(patch: { result: VestingRunResult | null; leftoverAllowance: bigint | null; approvalMessage?: string | null }): void {
  if (state.status !== "running") return;
  state = {
    ...state,
    status: "done",
    result: patch.result,
    states: patch.result ? [...patch.result.states] : state.states.map((): RowState => ({ status: "not_sent" })),
    leftoverAllowance: patch.leftoverAllowance,
    approvalMessage: patch.approvalMessage ?? null,
  };
  if (typeof window !== "undefined") window.removeEventListener("beforeunload", beforeUnloadGuard);
  emit();
}

function dismiss(): void {
  if (state.status !== "done") return;
  state = { status: "idle" };
  emit();
}

/** For tests: back to a blank session. */
function reset(): void {
  if (typeof window !== "undefined") window.removeEventListener("beforeunload", beforeUnloadGuard);
  state = { status: "idle" };
  emit();
}

export const session = { getSnapshot, subscribe, start, update, setStates, finish, dismiss, reset };
