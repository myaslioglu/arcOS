import type { Address } from "viem";
import type { Approval } from "@/lib/approvals";
import type { RowOutcome } from "./flow";
import { ALLOWANCE_STILL_SET, rowKey } from "./rows";

/**
 * Module-level store: at most one revoke run per page, independent of any window's lifetime, as Drop's send session
 * is (drop/session.ts). Closing Revoke unmounts its component, which would otherwise lose a revoke in flight along
 * with any record of it: the wallet prompt, the transaction hash, the failure. Kept here, the run keeps reporting
 * whatever happens to the window that started it, and any Revoke window, the same one reopened or a fresh one, picks
 * it back up through `getSnapshot`/`subscribe`.
 */

export type Failure = { text: string; hash?: string };
export type RevokeRun = {
  /** The owner whose approvals are being revoked, lowercased. */
  owner: string;
  /** The transaction under way, 1-based, of `steps`. */
  step: number;
  steps: number;
  /** The keys of the rows the current transaction carries. */
  current: string[];
  /** Asked to stop after the current transaction. */
  stopping: boolean;
  /** The wallet has signed the current transaction; its receipt is awaited. */
  sent: boolean;
};
export type OwnerState = { failures: Readonly<Record<string, Failure>>; left: Readonly<Record<string, string>> };
export type RevokeSessionState = { run: RevokeRun | null; owners: Readonly<Record<string, OwnerState>> };

const EMPTY_OWNER: OwnerState = { failures: {}, left: {} };
const initial: RevokeSessionState = { run: null, owners: {} };

let state: RevokeSessionState = initial;
/** The run under way, as a token of its own: a step number alone can't tell one run's step 1 from the next run's. */
let currentRun: object | null = null;
const listeners = new Set<() => void>();

function set(next: RevokeSessionState): void {
  state = next;
  for (const listener of listeners) listener();
}

function getSnapshot(): RevokeSessionState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** One owner's failures and leftover allowances, as the window shows them beside each row. */
function ownerState(s: RevokeSessionState, owner: string): OwnerState {
  return s.owners[owner.toLowerCase()] ?? EMPTY_OWNER;
}

function updateOwner(owner: string, update: (o: OwnerState) => OwnerState): void {
  const key = owner.toLowerCase();
  set({ ...state, owners: { ...state.owners, [key]: update(ownerState(state, key)) } });
}

function beforeUnloadGuard(e: BeforeUnloadEvent): void {
  e.preventDefault();
  e.returnValue = "";
}

/** Whether the run should go on after a step that came out as `outcomes`: not after a failure, nor when asked to stop. */
const goOn = (outcomes: readonly RowOutcome[]) => !outcomes.some((o) => o.result === "failed") && !state.run?.stopping;

/**
 * Runs `steps` one transaction at a time through `execute` (flow.ts's `revokeStep`, which calls the `onSent` it is
 * handed once the wallet has signed, so the run can say it is waiting for the receipt), and resolves with every row's
 * outcome. Refuses, returning null and changing nothing, while another run is under way, from this window or any
 * other. It stops at the first failure (the wallet refused, or a transaction didn't confirm: the next one shouldn't
 * be asked for until the visitor has seen why) or when `stop` was called, after the current transaction. The rows'
 * earlier failures are cleared as it starts; their new ones, and what a confirmed revoke left, are kept per owner.
 * While it runs, closing the tab asks first, as Drop does. `onEnd` hears every outcome just before the run is
 * cleared, which is when a window's "the run has ended" effect fires.
 */
function run(
  owner: Address,
  steps: readonly Approval[][],
  execute: (rows: Approval[], onSent: () => void) => Promise<RowOutcome[]>,
  onEnd?: (outcomes: RowOutcome[]) => void,
): Promise<RowOutcome[]> | null {
  if (state.run !== null || steps.length === 0) return null;
  const token = {};
  currentRun = token;
  const keys = new Set(steps.flat().map(rowKey));
  const drop = <T>(record: Readonly<Record<string, T>>) => Object.fromEntries(Object.entries(record).filter(([k]) => !keys.has(k)));
  updateOwner(owner, (o) => ({ failures: drop(o.failures), left: drop(o.left) }));
  set({ ...state, run: { owner: owner.toLowerCase(), step: 1, steps: steps.length, current: steps[0]!.map(rowKey), stopping: false, sent: false } });
  if (typeof window !== "undefined") window.addEventListener("beforeunload", beforeUnloadGuard);
  return (async () => {
    const all: RowOutcome[] = [];
    try {
      for (let i = 0; i < steps.length; i++) {
        const rows = steps[i]!;
        if (i > 0) set({ ...state, run: { ...state.run!, step: i + 1, current: rows.map(rowKey), sent: false } });
        const step = i + 1;
        // Marks this step's transaction sent; a call that comes late, once the run has moved on or ended (even when a
        // new run has reached the same step), is ignored.
        const onSent = () => {
          if (currentRun === token && state.run?.step === step && !state.run.sent) set({ ...state, run: { ...state.run, sent: true } });
        };
        let outcomes: RowOutcome[];
        try {
          outcomes = await execute(rows, onSent);
        } catch {
          // revokeStep reports its own failures; this is only for one that throws anyway.
          outcomes = rows.map((r) => ({ key: rowKey(r), result: "failed", text: "Something went wrong. Reopen Revoke to check this approval." }));
        }
        all.push(...outcomes);
        record(owner, outcomes);
        if (!goOn(outcomes)) break;
      }
    } finally {
      if (typeof window !== "undefined") window.removeEventListener("beforeunload", beforeUnloadGuard);
      // Before the run is cleared, so a window that is waiting for it to end already knows what ended.
      onEnd?.(all);
      if (currentRun === token) currentRun = null;
      set({ ...state, run: null });
    }
    return all;
  })();
}

function record(owner: string, outcomes: readonly RowOutcome[]): void {
  updateOwner(owner, (o) => {
    const failures = { ...o.failures };
    const left = { ...o.left };
    for (const out of outcomes) {
      if (out.result === "failed") failures[out.key] = { text: out.text, ...(out.hash ? { hash: out.hash } : {}) };
      if (out.result === "still-set") {
        left[out.key] = out.left;
        failures[out.key] = { text: ALLOWANCE_STILL_SET, hash: out.hash };
      }
    }
    return { failures, left };
  });
}

/** Asks a running bulk revoke to stop after its current transaction. */
function stop(): void {
  if (state.run && !state.run.stopping) set({ ...state, run: { ...state.run, stopping: true } });
}

/** Forgets everything (for tests). */
function forget(): void {
  currentRun = null;
  set(initial);
}

export const revokeSession = { getSnapshot, subscribe, ownerState, run, stop, forget };
