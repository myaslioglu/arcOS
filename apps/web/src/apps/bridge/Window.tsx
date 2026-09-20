"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { useAccount } from "wagmi";
import { AppKit, getErrorMessage, isRateLimitError, isUserCancellationError } from "@circle-fin/app-kit";
import { useDesktop } from "@arcos/shell";
import { ConnectGate } from "@/components/ConnectGate";
import { trackEvent } from "@/lib/analytics";
import { amountIssue, normalizedAmount } from "@/lib/amount";
import { ARC_CHAIN_NAME, adapterFor, bridgeFee, feeRecipient } from "@/lib/appkit";
import { bridgeChainOptions, type ChainId } from "./chains";
import { resolveRoute, type Direction } from "./route";
import { session } from "./session";

const STATE_LABEL: Record<string, string> = {
  success: "Bridge complete",
  pending: "Still finishing on the destination chain",
  error: "Bridge didn't complete",
};

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

  const submit = async () => {
    if (!connector || normalized === null) return;
    const started = session.start(source, dest, normalized);
    if (!started) return; // a bridge is already in flight (another click, another window) — do nothing
    try {
      const adapter = await adapterFor(connector);
      const chargeFee = recipient !== null && fee !== "0";
      const result = await kit.bridge({
        from: { adapter, chain: source },
        to: { adapter, chain: dest },
        amount: normalized,
        config: chargeFee ? { customFee: { value: fee, recipientAddress: recipient! } } : {},
      });
      session.finish(result);
      if (result.state === "success") trackEvent("bridge_success", { from: source, to: dest });
      notify(STATE_LABEL[result.state] ?? "Bridge submitted", result.state === "error" ? "warn" : "ok");
    } catch (err) {
      if (isUserCancellationError(err)) session.fail("Cancelled.");
      else if (isRateLimitError(err)) session.fail("The bridge service is busy. Try again in a minute.");
      else session.fail(getErrorMessage(err));
    }
  };

  const canSubmit = !sessionActive && !!connector && normalized !== null && issue === null;

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
                <p className="font-medium text-accent-text">{STATE_LABEL[bridgeSession.result.state] ?? bridgeSession.result.state}</p>
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
