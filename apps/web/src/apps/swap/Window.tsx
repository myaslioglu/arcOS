"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useAccount } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { AppKit, getErrorMessage, isRateLimitError, isUserCancellationError } from "@circle-fin/app-kit";
import { explorerUrl } from "@arcos/chain";
import { useDesktop } from "@arcos/shell";
import { ConnectGate } from "@/components/ConnectGate";
import { trackEvent } from "@/lib/analytics";
import { ARC_CHAIN_NAME, SWAP_FEE_BPS, SWAP_TOKENS, adapterFor, feeRecipient } from "@/lib/appkit";
import { amountIssue, normalizedAmount } from "@/lib/amount";
import { session } from "./session";
import { flipTokens, pickToken, type SwapToken, type TokenPair } from "./tokenPair";

const FEE_LABEL: Record<string, string> = { provider: "Provider fee", swap: "Swap fee", gas: "Gas fee", developer: "Developer fee" };

/** Shared by the estimate and the real swap so both ever see exactly the same request. */
function buildParams(adapter: Awaited<ReturnType<typeof adapterFor>>, tokenIn: SwapToken, tokenOut: SwapToken, amountIn: string) {
  const recipient = feeRecipient();
  return {
    from: { adapter, chain: ARC_CHAIN_NAME },
    tokenIn,
    tokenOut,
    amountIn,
    config: recipient ? { customFee: { percentageBps: SWAP_FEE_BPS, recipientAddress: recipient } } : {},
  };
}

function Form() {
  const { address, connector } = useAccount();
  const { notify } = useDesktop();
  const kit = useMemo(() => new AppKit(), []);

  const swapSession = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const sessionActive = swapSession.status === "swapping";

  const [pair, setPair] = useState<TokenPair>({ tokenIn: "USDC", tokenOut: "EURC" });
  const [amountIn, setAmountIn] = useState("");

  // Debounced 400ms after the last keystroke: estimateSwap is a network call against a rate-limited
  // (keyless) endpoint, so re-firing it on every keystroke would burn through that budget for nothing.
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setDebounced(amountIn), 400);
    return () => clearTimeout(id);
  }, [amountIn]);

  const amount = normalizedAmount(debounced);
  const recipient = feeRecipient();

  const estimateQuery = useQuery({
    queryKey: ["swap-estimate", pair.tokenIn, pair.tokenOut, amount, address],
    enabled: !!connector && !!address && amount !== null && !sessionActive,
    retry: false,
    queryFn: async () => {
      const adapter = await adapterFor(connector!);
      return kit.estimateSwap(buildParams(adapter, pair.tokenIn, pair.tokenOut, amount!));
    },
  });

  const submit = async () => {
    if (!connector || amount === null) return;
    const started = session.start(pair.tokenIn, pair.tokenOut, amount);
    if (!started) return; // a swap is already in flight (another click, another window) — do nothing
    try {
      const adapter = await adapterFor(connector);
      const result = await kit.swap(buildParams(adapter, pair.tokenIn, pair.tokenOut, amount));
      session.finish(result);
      trackEvent("swap_success", { pair: `${pair.tokenIn}-${pair.tokenOut}` });
      notify(result.progress.status === "DONE" ? "Swap complete" : "Swap submitted", "ok");
    } catch (err) {
      if (isUserCancellationError(err)) session.fail("Cancelled.");
      else if (isRateLimitError(err)) session.fail("The swap service is busy. Try again in a minute.");
      else session.fail(getErrorMessage(err));
    }
  };

  const issue = amountIssue(amountIn);
  const canSubmit = !sessionActive && !!connector && amount !== null && issue === null;

  const estimateError = estimateQuery.error
    ? isRateLimitError(estimateQuery.error)
      ? "The swap service is busy. Try again in a minute."
      : getErrorMessage(estimateQuery.error)
    : null;

  const tokenSelect = (side: "in" | "out", value: SwapToken) => (
    <select
      className="rounded-md border border-border-2 bg-surface px-2 py-1.5"
      value={value}
      disabled={sessionActive}
      onChange={(e) => setPair((p) => pickToken(p, side, e.target.value as SwapToken))}
      aria-label={side === "in" ? "Token to send" : "Token to receive"}
    >
      {SWAP_TOKENS.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
  );

  return (
    <div className="flex h-full flex-col text-sm">
      <div className="min-h-0 flex-1 overflow-auto p-5">
        <div className="grid gap-3">
          <label className="block">
            <span className="text-xs text-muted">You send</span>
            <div className="mt-1 flex gap-2">
              <input
                className="min-w-0 flex-1 rounded-md border border-border-2 bg-surface px-2 py-1.5"
                value={amountIn}
                disabled={sessionActive}
                placeholder="0.00"
                inputMode="decimal"
                onChange={(e) => setAmountIn(e.target.value)}
                aria-label="Amount to send"
                aria-invalid={!!issue}
              />
              {tokenSelect("in", pair.tokenIn)}
            </div>
            {issue && <span className="mt-1 block text-xs text-accent-3-text">{issue}</span>}
          </label>

          <button
            type="button"
            className="w-fit rounded-md border border-border-2 px-2 py-1 text-xs text-muted"
            disabled={sessionActive}
            onClick={() => setPair(flipTokens)}
            aria-label="Swap the two tokens"
          >
            ⇅ Flip
          </button>

          <label className="block">
            <span className="text-xs text-muted">You receive (estimated)</span>
            <div className="mt-1 flex gap-2">
              <input
                className="min-w-0 flex-1 rounded-md border border-border-2 bg-surface px-2 py-1.5"
                value={estimateQuery.data ? estimateQuery.data.estimatedOutput.amount : ""}
                readOnly
                placeholder={amount === null ? "" : estimateQuery.isFetching ? "Estimating…" : ""}
                aria-label="Estimated amount to receive"
              />
              {tokenSelect("out", pair.tokenOut)}
            </div>
          </label>
        </div>

        <div className="mt-3 grid gap-1 text-xs text-muted">
          {estimateError && <p className="text-accent-3-text">{estimateError}</p>}
          {estimateQuery.data && (
            <>
              <p>
                Minimum received: {estimateQuery.data.stopLimit.amount} {estimateQuery.data.stopLimit.token}
              </p>
              {estimateQuery.data.fees?.map((fee, i) =>
                fee.amount === null ? null : (
                  <p key={i}>
                    {FEE_LABEL[fee.type] ?? fee.type}: {fee.amount} {fee.token}
                  </p>
                ),
              )}
            </>
          )}
          {recipient && <p>Platform fee 0.20%</p>}
        </div>

        {swapSession.status === "done" && (
          <div className="mt-4 rounded-md border border-border-2 p-3 text-xs">
            {swapSession.result ? (
              <>
                <p className="font-medium text-accent-text">
                  {swapSession.result.progress.status === "DONE" ? "Swap complete" : "Swap submitted"}
                </p>
                {swapSession.result.amountOut && (
                  <p className="mt-1">
                    Received ≈ {swapSession.result.amountOut} {swapSession.result.tokenOut}
                  </p>
                )}
                <a
                  className="mt-1 block break-all font-mono text-accent-text"
                  href={explorerUrl("tx", swapSession.result.txHash)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {swapSession.result.txHash}
                </a>
              </>
            ) : (
              <p className="text-accent-3-text">{swapSession.error}</p>
            )}
            <button
              type="button"
              className="mt-2 rounded-md border border-border-2 px-2 py-1"
              onClick={() => {
                session.dismiss();
                setAmountIn("");
              }}
            >
              Done
            </button>
          </div>
        )}
      </div>

      <div className="border-t border-border p-3">
        <button type="button" disabled={!canSubmit} className="w-full rounded-md border border-border-2 px-3 py-2" onClick={submit}>
          {sessionActive ? "Waiting for your wallet…" : "Swap"}
        </button>
      </div>
    </div>
  );
}

export default function SwapWindow() {
  return (
    <ConnectGate>
      <Form />
    </ConnectGate>
  );
}
