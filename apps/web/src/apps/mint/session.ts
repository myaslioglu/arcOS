import type { Address } from "@arcos/chain";

export type MintSessionStatus = "idle" | "minting" | "done";

export type MintResult = { token: Address; symbol: string; decimals: number };

export type MintSessionState = {
  status: MintSessionStatus;
  /** The symbol being minted — captured once at `start`, so a reopened window can say what's in
   * flight ("Minting DUKE…") without re-reading the form, which no longer exists once the window
   * that held it has been closed. */
  symbol: string;
  result: MintResult | null;
  /** Set instead of `result` when the mint failed (a stale fee, a simulate revert, a refused
   * signature, ...) — never both at once. */
  error: string | null;
  startedAt: number | null;
};

export const initialMintSessionState: MintSessionState = {
  status: "idle",
  symbol: "",
  result: null,
  error: null,
  startedAt: null,
};

export type MintSessionAction =
  | { type: "start"; symbol: string; startedAt: number }
  | { type: "finish"; result: MintResult }
  | { type: "fail"; message: string }
  | { type: "dismiss" };

/**
 * Pure state machine for one Mint session — mirrors apps/drop/session.ts, apps/swap/session.ts and
 * apps/bridge/session.ts. A mint is a single paid, irreversible on-chain call: `start` only applies
 * from "idle" or "done" (a no-op from "minting" is the hard guard against a second concurrent —
 * and separately charged — mint, from any number of windows or clicks). `finish`/`fail` only apply
 * from "minting"; `dismiss` only from "done".
 */
export function mintSessionReducer(state: MintSessionState, action: MintSessionAction): MintSessionState {
  switch (action.type) {
    case "start":
      if (state.status === "minting") return state;
      return { status: "minting", symbol: action.symbol, result: null, error: null, startedAt: action.startedAt };
    case "finish":
      return state.status === "minting" ? { ...state, status: "done", result: action.result, error: null } : state;
    case "fail":
      return state.status === "minting" ? { ...state, status: "done", result: null, error: action.message } : state;
    case "dismiss":
      return state.status === "done" ? { ...initialMintSessionState } : state;
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

  /** Records a failure; only takes effect while minting. */
  function fail(message: string): void {
    if (state.status !== "minting") return;
    state = mintSessionReducer(state, { type: "fail", message });
    resolveTarget()?.removeEventListener("beforeunload", beforeUnloadGuard);
    emit();
  }

  /** Dismisses a finished session, returning to a blank form; only takes effect while done. */
  function dismiss(): void {
    const next = mintSessionReducer(state, { type: "dismiss" });
    if (next === state) return;
    state = next;
    emit();
  }

  return { getSnapshot, subscribe, start, finish, fail, dismiss };
}

export const session = createMintSession();
