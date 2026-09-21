import type { Address } from "@arcos/chain";
import { UserFacingError, describeContractError } from "@/lib/contract-error";

export type MintSessionStatus = "idle" | "minting" | "unconfirmed" | "done";

export type MintResult = { token: Address; symbol: string; decimals: number };

export type MintSessionState = {
  status: MintSessionStatus;
  /** The symbol being minted — captured once at `start`, so a reopened window can say what's in
   * flight ("Minting DUKE…") without re-reading the form, which no longer exists once the window
   * that held it has been closed. */
  symbol: string;
  result: MintResult | null;
  /** Set instead of `result` when the mint failed (a stale fee, a simulate revert, a refused
   * signature, ...) or is unconfirmed — never both `result` and `error` at once. */
  error: string | null;
  /** The transaction hash of THIS session, once one was actually broadcast — whether the outcome
   * was unconfirmed (a hash exists but no receipt could be obtained, so the outcome is genuinely
   * unknown) or a definite failure with a receipt (a revert). Either way a reopened window can
   * still show a working explorer link. */
  hash: `0x${string}` | null;
  /** The hash of the PREVIOUS session's transaction, kept through `dismiss` so the form can offer
   * it as "Last transaction" — dismissing means "I have seen this", not "throw away the only link
   * to a transaction I may still need to look up". Cleared when the next mint starts, since from
   * then on `hash` describes the current one. Lives here rather than in the window's own state so
   * closing and reopening the window doesn't lose it. */
  lastHash: `0x${string}` | null;
  startedAt: number | null;
};

export const initialMintSessionState: MintSessionState = {
  status: "idle",
  symbol: "",
  result: null,
  error: null,
  hash: null,
  lastHash: null,
  startedAt: null,
};

export type MintSessionAction =
  | { type: "start"; symbol: string; startedAt: number }
  | { type: "finish"; result: MintResult }
  | { type: "fail"; message: string; hash?: `0x${string}` }
  | { type: "unconfirmed"; message: string; hash: `0x${string}` }
  | { type: "dismiss" };

/**
 * Pure state machine for one Mint session — mirrors apps/drop/session.ts, apps/swap/session.ts and
 * apps/bridge/session.ts. A mint is a single paid, irreversible on-chain call: `start` only applies
 * from "idle", "done" or "unconfirmed" (a no-op from "minting" is the hard guard against a second
 * concurrent — and separately charged — mint, from any number of windows or clicks). `finish`/`fail`/
 * `unconfirmed` only apply from "minting"; `dismiss` applies from "done" or "unconfirmed".
 *
 * "unconfirmed" is deliberately a THIRD terminal status, not a flavor of "done": a mint whose receipt
 * couldn't be obtained (RPC timeout, disconnect, ...) after a transaction was already broadcast has no
 * definite outcome — it is neither a confirmed success nor a confirmed failure — so it must never be
 * presented, or ever be mistaken by calling code, as either one. See `classifyMintFailure` below for
 * how a caught error decides which of "fail"/"unconfirmed" applies.
 */
export function mintSessionReducer(state: MintSessionState, action: MintSessionAction): MintSessionState {
  switch (action.type) {
    case "start":
      if (state.status === "minting") return state;
      return { status: "minting", symbol: action.symbol, result: null, error: null, hash: null, lastHash: null, startedAt: action.startedAt };
    case "finish":
      return state.status === "minting" ? { ...state, status: "done", result: action.result, error: null } : state;
    case "fail":
      // A failure can still have a hash: a mint that reverts was broadcast and mined, and the
      // receipt that proves it reverted is the thing a user will want to look at.
      return state.status === "minting" ? { ...state, status: "done", result: null, error: action.message, hash: action.hash ?? null } : state;
    case "unconfirmed":
      return state.status === "minting"
        ? { ...state, status: "unconfirmed", result: null, error: action.message, hash: action.hash }
        : state;
    case "dismiss":
      return state.status === "done" || state.status === "unconfirmed"
        ? { ...initialMintSessionState, lastHash: state.hash ?? state.lastHash }
        : state;
  }
}

/**
 * The wave E fix for I3: decides what a mint's catch block should show, and whether the session
 * store should keep the hash visible ("unconfirmed") rather than reporting a plain failure — pulled
 * out as a pure function (per the brief) so it's unit-tested without needing a live wallet/RPC.
 *
 * `hashKnown` is true once `writeContractAsync` has returned a hash — the transaction was broadcast,
 * so the user may already have paid. Order matters:
 * 1. A `UserFacingError` is always this app's own, definite decision about what happened (a stale-fee
 *    stop before signing, or — once a receipt WAS obtained — an explicit "it reverted" throw in
 *    Window.tsx). It is never "unconfirmed", regardless of `hashKnown`: by the time it throws, the
 *    outcome is already known. (The receipt-succeeded-but-no-token-reported case is deliberately NOT
 *    a `UserFacingError` — Window.tsx calls `session.unconfirmed()` directly for it instead, wave G's
 *    N6: the fee WAS taken with a real success receipt, but there's nothing to confirm what was
 *    created, which is exactly the "check the explorer" situation case 2 below describes.)
 * 2. Otherwise, if a hash is known, something failed AFTER broadcast with no definite answer — most
 *    likely `waitForTransactionReceipt` itself rejecting (timeout, dropped connection) — so the mint
 *    may have gone through. Saying "Try again" here would invite a second, separately-charged mint;
 *    this reports "unconfirmed" and tells the user to check the explorer instead.
 * 3. Otherwise nothing was ever sent (simulate reverted, the signature was refused, ...), so the
 *    normal `describeContractError` mapping applies.
 */
export function classifyMintFailure(hashKnown: boolean, err: unknown): { message: string; unconfirmed: boolean } {
  if (err instanceof UserFacingError) return { message: err.message, unconfirmed: false };
  if (hashKnown) {
    return { message: "Your transaction was sent but we couldn't confirm it. Check it on the explorer before minting again.", unconfirmed: true };
  }
  return { message: describeContractError(err), unconfirmed: false };
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
 * The production singleton is the one export that matters at runtime: at most one Mint in flight per
 * page, independent of any single window's lifetime — see apps/drop/session.ts for the full
 * rationale (closing the window unmounts the form, which must not orphan a paid transaction the
 * chain is still confirming, and must not invite a second, separately-charged mint from a blank
 * reopened form).
 *
 * `target` defaults to the real `window` when one exists and `undefined` otherwise (SSR / this
 * workspace's node test environment) — re-resolved on every call, matching swap/bridge's session.
 */
export function createMintSession(target?: BeforeUnloadTarget) {
  const resolveTarget = (): BeforeUnloadTarget | undefined => target ?? (typeof window === "undefined" ? undefined : window);

  let state: MintSessionState = initialMintSessionState;
  const listeners = new Set<() => void>();

  function emit(): void {
    for (const listener of listeners) listener();
  }

  function getSnapshot(): MintSessionState {
    return state;
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** Starts a session; refuses — returns `false`, changes nothing — if one is already minting. */
  function start(symbol: string): boolean {
    if (state.status === "minting") return false;
    state = mintSessionReducer(state, { type: "start", symbol, startedAt: Date.now() });
    resolveTarget()?.addEventListener("beforeunload", beforeUnloadGuard);
    emit();
    return true;
  }

  /** Records the created token; only takes effect while minting. */
  function finish(result: MintResult): void {
    if (state.status !== "minting") return;
    state = mintSessionReducer(state, { type: "finish", result });
    resolveTarget()?.removeEventListener("beforeunload", beforeUnloadGuard);
    emit();
  }

  /** Records a failure; only takes effect while minting. `hash` is set when the transaction had
   * already been broadcast (a revert), so the failure can still be linked to the explorer. */
  function fail(message: string, hash?: `0x${string}`): void {
    if (state.status !== "minting") return;
    state = mintSessionReducer(state, { type: "fail", message, hash });
    resolveTarget()?.removeEventListener("beforeunload", beforeUnloadGuard);
    emit();
  }

  /** Records a broadcast-but-unconfirmed outcome (see `classifyMintFailure`); only takes effect while
   * minting. Keeps `hash` on the state so a reopened window can still show the explorer link. */
  function unconfirmed(message: string, hash: `0x${string}`): void {
    if (state.status !== "minting") return;
    state = mintSessionReducer(state, { type: "unconfirmed", message, hash });
    resolveTarget()?.removeEventListener("beforeunload", beforeUnloadGuard);
    emit();
  }

  /** Dismisses a finished or unconfirmed session, returning to a blank form; only takes effect from
   * those two states. */
  function dismiss(): void {
    const next = mintSessionReducer(state, { type: "dismiss" });
    if (next === state) return;
    state = next;
    emit();
  }

  return { getSnapshot, subscribe, start, finish, fail, unconfirmed, dismiss };
}

export const session = createMintSession();
