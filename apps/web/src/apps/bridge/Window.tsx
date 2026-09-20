"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { useAccount } from "wagmi";
import { AppKit, getErrorMessage, isRateLimitError, isRetryableError, isUserCancellationError, type BridgeResult } from "@circle-fin/app-kit";
import { useDesktop, type Tone } from "@arcos/shell";
import { ConnectGate } from "@/components/ConnectGate";
import { trackEvent } from "@/lib/analytics";
import { amountIssue, normalizedAmount } from "@/lib/amount";
import { ARC_CHAIN_NAME, adapterFor, bridgeFee, feeRecipient } from "@/lib/appkit";
import { bridgeChainOptions, chainLabel, type ChainId } from "./chains";
import { explorerCheckNote, fundsLeftSource, inFlightNote } from "./inFlight";
import { resolveRoute, type Direction } from "./route";
import { session } from "./session";

const STATE_LABEL: Record<string, string> = {
  success: "Bridge complete",
  pending: "Still finishing on the destination chain",
  error: "The bridge stopped before finishing",
};
const STATE_TONE: Record<string, Tone> = { success: "ok", pending: "info", error: "warn" };

function Form() {
  const { connector } = useAccount();
  const { notify } = useDesktop();
  const kit = useMemo(() => new AppKit(), []);

  const bridgeSession = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const sessionActive = bridgeSession.status === "bridging";

  const options = useMemo(() => bridgeChainOptions(), []);
  const [direction, setDirection] = useState<Direction>("toArc");
  // `options` is a fixed 6-entry list (see ./chains) — never empty, so index 0 always exists.
  const [otherChain, setOtherChain] = useState<ChainId>(options[0]!.chain);
  const [amount, setAmount] = useState("");

  const { source, dest } = resolveRoute(direction, otherChain, ARC_CHAIN_NAME);
  const issue = amountIssue(amount);
  const normalized = normalizedAmount(amount);
  const recipient = feeRecipient();
  const fee = normalized ? bridgeFee(normalized) : "0";

  /** Runs `run()` through the shared one-at-a-time session guard, from the initial submit or from a
   * Retry — both a fresh `kit.bridge()` call and `kit.retryBridge()` land here so they share exactly
   * the same start/finish/fail handling. On a thrown error, appends the "check your wallet's chain
   * explorer" note: a promise rejection here can still follow a burn that already landed. */
  const performBridge = async (bridgeSource: ChainId, bridgeDest: ChainId, bridgeAmount: string, run: () => Promise<BridgeResult>) => {
    const started = session.start(bridgeSource, bridgeDest, bridgeAmount);
    if (!started) return; // a bridge is already in flight (another click, another window) — do nothing
    try {
      const result = await run();
      session.finish(result);
      if (result.state === "success") trackEvent("bridge_success", { from: bridgeSource, to: bridgeDest });
      notify(STATE_LABEL[result.state] ?? "Bridge submitted", STATE_TONE[result.state] ?? "info");
    } catch (err) {
      const note = explorerCheckNote(chainLabel(bridgeSource));
      if (isUserCancellationError(err)) session.fail("Cancelled.");
      else if (isRateLimitError(err)) session.fail(`The bridge service is busy. Try again in a minute. ${note}`);
      else session.fail(`${getErrorMessage(err)} ${note}`);
    }
  };

  const submit = async () => {
    if (!connector || normalized === null) return;
    await performBridge(source, dest, normalized, async () => {
      const adapter = await adapterFor(connector);
      const chargeFee = recipient !== null && fee !== "0";
      return kit.bridge({
        from: { adapter, chain: source },
        to: { adapter, chain: dest },
        amount: normalized,
        config: chargeFee ? { customFee: { value: fee, recipientAddress: recipient! } } : {},
      });
    });
  };

  const retry = async () => {
    const failed = bridgeSession.result;
    if (!connector || !failed || !bridgeSession.source || !bridgeSession.dest) return;
    const retrySource = bridgeSession.source;
    const retryDest = bridgeSession.dest;
    await performBridge(retrySource, retryDest, bridgeSession.amount, async () => {
      const adapter = await adapterFor(connector);
      return kit.retryBridge(failed, { from: adapter, to: adapter });
    });
  };

  const canSubmit = !sessionActive && !!connector && normalized !== null && issue === null;

  // Whether the failed step's own error is one the SDK considers worth retrying — per the SDK's
  // documented pattern (node_modules/@circle-fin/app-kit/index.d.ts ~line 32714): find the step that
  // recorded an error and ask isRetryableError about that error, not about the result as a whole.
  const failedStep = bridgeSession.result?.steps.find((s) => s.state === "error" && s.error);
  const canRetry = bridgeSession.result?.state === "error" && !!failedStep?.error && isRetryableError(failedStep.error);

  const stoppedNote =
    bridgeSession.result && bridgeSession.result.state === "error"
      ? inFlightNote(bridgeSession.result.source.chain.name, bridgeSession.result.destination.chain.name, fundsLeftSource(bridgeSession.result.steps))
      : null;

  return (
    <div className="flex h-full flex-col text-sm">
      <div className="min-h-0 flex-1 overflow-auto p-5">
        <div className="inline-flex rounded-md border border-border-2 p-0.5">
          <button
            type="button"
            aria-pressed={direction === "toArc"}
            disabled={sessionActive}
            className={`rounded px-2 py-1 ${direction === "toArc" ? "bg-surface-2" : ""}`}
            onClick={() => setDirection("toArc")}
          >
            To Arc
          </button>
          <button
            type="button"
            aria-pressed={direction === "fromArc"}
            disabled={sessionActive}
            className={`rounded px-2 py-1 ${direction === "fromArc" ? "bg-surface-2" : ""}`}
            onClick={() => setDirection("fromArc")}
          >
            From Arc
          </button>
        </div>

        <label className="mt-3 block">
          <span className="text-xs text-muted">{direction === "toArc" ? "From" : "To"}</span>
          <select
            className="mt-1 w-full rounded-md border border-border-2 bg-surface px-2 py-1.5"
            value={otherChain}
            disabled={sessionActive}
            onChange={(e) => setOtherChain(e.target.value as ChainId)}
            aria-label={direction === "toArc" ? "Source chain" : "Destination chain"}
          >
            {options.map((o) => (
              <option key={o.chain} value={o.chain}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <label className="mt-3 block">
          <span className="text-xs text-muted">Amount (USDC)</span>
          <input
            className="mt-1 w-full rounded-md border border-border-2 bg-surface px-2 py-1.5"
            value={amount}
            disabled={sessionActive}
            placeholder="0.00"
            inputMode="decimal"
            onChange={(e) => setAmount(e.target.value)}
            aria-label="Amount to bridge"
            aria-invalid={!!issue}
          />
          {issue && <span className="mt-1 block text-xs text-accent-3-text">{issue}</span>}
        </label>

        {recipient && (
          <p className="mt-3 text-xs text-muted">
            Fee {fee} USDC (0.20%) · added on top
          </p>
        )}

        {sessionActive && (
          <p className="mt-3 text-muted">
            Bridging — this can take a few minutes. You can close this window; the bridge continues.
          </p>
        )}

        {bridgeSession.status === "done" && (
          <div className="mt-4 rounded-md border border-border-2 p-3 text-xs">
            {bridgeSession.result ? (
              <>
                <p className={`font-medium ${STATE_TONE[bridgeSession.result.state] === "warn" ? "text-accent-3-text" : "text-accent-text"}`}>
                  {STATE_LABEL[bridgeSession.result.state] ?? bridgeSession.result.state}
                </p>
                {stoppedNote && <p className="mt-1">{stoppedNote}</p>}
                {bridgeSession.result.warnings?.map((w, i) => (
                  <p key={i} className="mt-1 text-accent-3-text">
                    {w.message ?? w.code}
                  </p>
                ))}
                <ul className="mt-1 grid gap-1">
                  {bridgeSession.result.steps.map((step, i) => (
                    <li key={i}>
                      {step.name}: {step.state}
                      {step.explorerUrl && step.txHash && (
                        <>
                          {" — "}
                          <a className="break-all font-mono text-accent-text" href={step.explorerUrl} target="_blank" rel="noreferrer">
                            {step.txHash}
                          </a>
                        </>
                      )}
                      {step.errorMessage && <span className="text-accent-3-text"> — {step.errorMessage}</span>}
                    </li>
                  ))}
                </ul>
                {canRetry && (
                  <button type="button" className="mt-2 rounded-md border border-border-2 px-2 py-1" onClick={retry}>
                    Retry
                  </button>
                )}
              </>
            ) : (
              <p className="text-accent-3-text">{bridgeSession.error}</p>
            )}
            <button
              type="button"
              className="mt-2 rounded-md border border-border-2 px-2 py-1"
              onClick={() => {
                session.dismiss();
                setAmount("");
              }}
            >
              Done
            </button>
          </div>
        )}
      </div>

      <div className="border-t border-border p-3">
        <button type="button" disabled={!canSubmit} className="w-full rounded-md border border-border-2 px-3 py-2" onClick={submit}>
          {sessionActive ? "Waiting for your wallet…" : "Bridge"}
        </button>
      </div>
    </div>
  );
}

export default function BridgeWindow() {
  return (
    <ConnectGate>
      <Form />
    </ConnectGate>
  );
}
