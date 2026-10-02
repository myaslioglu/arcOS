import {
  BalanceError,
  QUOTE_NOT_REUSED_WARNING_CODE,
  SPEED_DOWNGRADED_WARNING_CODE,
  isBalanceError,
  isRateLimitError,
  type BridgeResult,
  type BridgeStep,
  type BridgeWarning,
} from "@circle-fin/app-kit";
import { GENERIC_TRANSACTION_ERROR } from "@/lib/contract-error";
import { isKitCancellation } from "@/lib/kit-errors";
import { EMBEDDED_FRAME_MESSAGE, isEmbeddedFrameRefusal } from "@/lib/wallet-frame";
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
  | { type: "start"; source: ChainId; dest: ChainId; amount: string; retry: boolean; startedAt: number }
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
        // wave E, I4: `lastResult` (the evidence a Retry panel shows) must only survive a `start` that
        // is ITSELF a retry of that same evidence. A fresh, non-retry start — a brand-new transfer,
        // typed and submitted after a previous one finished — must not inherit a stranger's burn hash:
        // before this, `start` carried `lastResult` forward unconditionally, so a new transfer could
        // render "Retrying. Your first attempt:" over a completely unrelated prior bridge, and a
        // failed new attempt could show that unrelated bridge's SUCCESS underneath its own error.
        lastResult: action.retry ? state.lastResult : null,
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

/**
 * What Bridge's submit catch shows, pulled out of Window.tsx like Swap's `classifySwapFailure` so it's unit-tested
 * without a live wallet, RPC or SDK. `note` is the "check the source chain's explorer" hint (inFlight.ts's
 * `explorerCheckNote`), since a failure after the burn can still mean the funds left.
 *
 * - A wallet that took the page for an embedded frame comes first: it refuses the first request, so nothing was sent,
 *   and only a reload helps (lib/wallet-frame.ts).
 * - A cancellation and a rate limit keep their own sentences.
 * - Not enough USDC or gas on the source chain gets a sentence that names the chain (`source`), when the caller passes it.
 * - Anything else gets `GENERIC_TRANSACTION_ERROR`, never the error's own text: like every other wallet, RPC or SDK
 *   error this app shows, it can carry internal detail or a URL.
 */
export function classifyBridgeFailure(err: unknown, note: string, source?: BridgeFailureSource): string {
  if (isEmbeddedFrameRefusal(err)) return EMBEDDED_FRAME_MESSAGE;
  if (isKitCancellation(err)) return "Cancelled.";
  if (isRateLimitError(err)) return `The bridge service is busy. Try again in a minute. ${note}`;
  if (source && isBalanceError(err)) {
    const message = balanceFailureMessage(err.code, source);
    if (message) return message;
  }
  return `${GENERIC_TRANSACTION_ERROR} ${note}`;
}

/** The source chain of a failed bridge, as `classifyBridgeFailure` names it: its display name and its gas token. */
export type BridgeFailureSource = { label: string; gasSymbol: string };

/**
 * App Kit checks the wallet's USDC on the source chain before it asks the wallet for anything, and throws
 * `BALANCE_INSUFFICIENT_TOKEN` (9001) when it is short: that was Bridge's "fails at once", shown as the generic sentence.
 * Its own message names the chain but is still the SDK's text, so the sentence is the app's own. A gas shortfall (9002)
 * is the RPC's "insufficient funds for gas" read by the SDK. Any other balance code falls through to the generic sentence.
 */
function balanceFailureMessage(code: number, { label, gasSymbol }: BridgeFailureSource): string | null {
  if (code === BalanceError.INSUFFICIENT_TOKEN.code) {
    return `Your wallet doesn't have enough USDC on ${label} for this amount and the fee. Pick the chain that holds your USDC, or lower the amount.`;
  }
  if (code === BalanceError.INSUFFICIENT_GAS.code) {
    return `Your wallet doesn't have enough ${gasSymbol} on ${label} to pay for gas. Add some ${gasSymbol} there and try again.`;
  }
  return null;
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

  /** Starts a session; refuses — returns `false`, changes nothing — if one is already bridging.
   * `retry` must be true only when this start is retrying the attempt `lastResult` (if any) already
   * describes — see bridgeSessionReducer's "start" case for why a fresh, non-retry start clears it. */
  function start(source: ChainId, dest: ChainId, amount: string, retry: boolean): boolean {
    if (state.status === "bridging") return false;
    state = bridgeSessionReducer(state, { type: "start", source, dest, amount, retry, startedAt: Date.now() });
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

/**
 * What a finished bridge's step list says for a step that failed, in the app's own words: the SDK's `errorMessage` is
 * viem's text ("User rejected the request. Request Arguments: from: 0x…"), which names addresses and the call's
 * arguments, and is never shown. Checked in order, by the SDK's own classification of the step (`errorCategory`), then
 * the step's `error` (a KitError, wrapping the wallet's or the node's own error under `cause.trace.rawError`) and the
 * words of its chain, which only ever pick a sentence:
 *
 * - the SDK says the visitor rejected it (`errorCategory: "user_rejected"`);
 * - the wallet took the page for an embedded frame (`EMBEDDED_FRAME_MESSAGE`);
 * - the wallet didn't switch to the step's chain: the adapter's "Failed to switch to chain" wrapper, or code 4902;
 * - the visitor rejected the request: the kit's own cancellation check, or EIP-1193's 4001 anywhere in the chain;
 * - not enough USDC (9001) or gas (9002) on that chain, worded by `balanceFailureMessage`;
 * - anything else: one generic sentence.
 *
 * `chain` is where the step ran: the source for an approval or a burn, the destination for a mint.
 *
 * This runs during render, so it never throws: an error object whose `code`, `message` or `type` getter throws (the
 * kit's guards read those) gets the generic sentence.
 */
export function describeStepError(step: Pick<BridgeStep, "error" | "errorMessage" | "errorCategory">, chain: BridgeFailureSource): string {
  try {
    if (step.errorCategory === "user_rejected") return STEP_REJECTED;
    const err = step.error ?? step.errorMessage;
    if (isEmbeddedFrameRefusal(err)) return EMBEDDED_FRAME_MESSAGE;
    const nodes = errorChain(err);
    const codes = nodes.map((n) => (typeof n === "object" && n !== null ? (n as { code?: unknown }).code : undefined));
    const words = nodes.map((n) => (typeof n === "string" ? n : textOf(n))).join(" ");
    if (codes.includes(4902) || SWITCH_REFUSED.test(words)) return `Your wallet didn't switch to ${chain.label}.`;
    if (codes.includes(4001) || isKitCancellation(err)) return STEP_REJECTED;
    if (isBalanceError(err)) {
      const message = balanceFailureMessage(err.code, chain);
      if (message) return message;
    }
    return STEP_UNKNOWN;
  } catch {
    return STEP_UNKNOWN;
  }
}

const STEP_REJECTED = "Rejected in your wallet.";
const STEP_UNKNOWN = "This step didn't finish.";

/**
 * What a `BridgeResult`'s warning says, by its code: the two the installed App Kit defines get a sentence of their own,
 * any other code one generic sentence. The SDK's `message` is never shown, like every other SDK text. Never throws: a
 * warning whose `code` getter throws reads as unknown.
 */
export function describeWarning(warning: Pick<BridgeWarning, "code">): string {
  try {
    switch (warning.code) {
      case SPEED_DOWNGRADED_WARNING_CODE:
        return "The fast transfer wasn't available, so this bridge takes the slower route. Your USDC still arrives.";
      case QUOTE_NOT_REUSED_WARNING_CODE:
        return "The fee quoted beforehand couldn't be reused, so the fee paid may differ from it.";
      default:
        return "The bridge reported a warning.";
    }
  } catch {
    return "The bridge reported a warning.";
  }
}

/** The adapter's wrapper around a chain switch the wallet refused or failed (adapter-viem-v2's `switchToChain`). */
const SWITCH_REFUSED = /failed to switch to chain/i;

/** An error's own words, never shown: viem's `shortMessage` and `details`, or a plain `message`. */
function textOf(node: unknown): string {
  if (typeof node !== "object" || node === null) return "";
  const { shortMessage, details, message } = node as Record<string, unknown>;
  return [shortMessage, details, message].filter((v): v is string => typeof v === "string").join(" ");
}

/**
 * Every node of an error's chain: its `cause`, and the places Circle's App Kit keeps a wrapped error (`cause.trace.rawError`,
 * `rawError`, `cause.trace.originalError`), breadth first and each object once.
 */
function errorChain(err: unknown): unknown[] {
  const seen = new Set<unknown>();
  const out: unknown[] = [];
  const queue: unknown[] = [err];
  while (queue.length > 0 && out.length < 64) {
    const current = queue.shift();
    if (current === null || current === undefined) continue;
    if (typeof current === "string") {
      out.push(current);
      continue;
    }
    if (typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    out.push(current);
    try {
      const node = current as { cause?: unknown; rawError?: unknown };
      const trace = (node.cause as { trace?: { rawError?: unknown; originalError?: unknown } } | undefined)?.trace;
      queue.push(node.cause, node.rawError, trace?.rawError, trace?.originalError);
    } catch {
      // A getter that throws reads as no further cause.
    }
  }
  return out;
}
