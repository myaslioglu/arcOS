"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useAccount } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { AppKit, getErrorMessage, isRateLimitError, isUserCancellationError } from "@circle-fin/app-kit";
import { useDesktop } from "@arcos/shell";
import { ConnectGate } from "@/components/ConnectGate";
import { trackEvent } from "@/lib/analytics";
import { ARC_CHAIN_NAME, SWAP_FEE_BPS, SWAP_TOKENS, SWAP_TOKEN_DECIMALS, adapterFor, feePercentLabel, feeRecipient } from "@/lib/appkit";
import { amountIssue, normalizedAmount } from "@/lib/amount";
import { canSwap } from "./canSwap";
import { presentSwapResult } from "./presentResult";
import { session } from "./session";
import { slippageBpsFor, slippagePercentLabel } from "./slippage";
import { flipTokens, pickToken, type SwapToken, type TokenPair } from "./tokenPair";

const FEE_LABEL: Record<string, string> = { provider: "Provider fee", swap: "Swap fee", gas: "Gas fee" };
const PLATFORM_FEE_LABEL = `Platform fee (${feePercentLabel(SWAP_FEE_BPS)})`;

/** Shared by the estimate and the real swap so both ever see exactly the same request, except for
 * `stopLimit`: only the real swap passes it (the floor the transaction should actually honour —
 * an estimate call has no prior estimate to enforce one from). */
function buildParams(
  adapter: Awaited<ReturnType<typeof adapterFor>>,
  tokenIn: SwapToken,
  tokenOut: SwapToken,
  amountIn: string,
  stopLimit?: string,
) {
  const recipient = feeRecipient();
  return {
    from: { adapter, chain: ARC_CHAIN_NAME },
    tokenIn,
    tokenOut,
    amountIn,
    config: {
      slippageBps: slippageBpsFor(tokenIn, tokenOut),
      ...(stopLimit ? { stopLimit } : {}),
      ...(recipient ? { customFee: { percentageBps: SWAP_FEE_BPS, recipientAddress: recipient } } : {}),
    },
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
  const decimalsIn = SWAP_TOKEN_DECIMALS[pair.tokenIn];

  // Debounced 400ms after the last keystroke: estimateSwap is a network call against a rate-limited
  // (keyless) endpoint, so re-firing it on every keystroke would burn through that budget for nothing.
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setDebounced(amountIn), 400);
    return () => clearTimeout(id);
  }, [amountIn]);

  const amount = normalizedAmount(debounced, decimalsIn);

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
    if (!connector || amount === null || !estimateQuery.data) return;
    const started = session.start(pair.tokenIn, pair.tokenOut, amount);
    if (!started) return; // a swap is already in flight (another click, another window) — do nothing
    try {
      const adapter = await adapterFor(connector);
      const result = await kit.swap(buildParams(adapter, pair.tokenIn, pair.tokenOut, amount, estimateQuery.data.stopLimit.amount));
      session.finish(result);
      const presentation = presentSwapResult(result);
      if (presentation.isSuccess) trackEvent("swap_success", { pair: `${pair.tokenIn}-${pair.tokenOut}` });
      notify(presentation.headline, presentation.tone);
    } catch (err) {
      if (isUserCancellationError(err)) session.fail("Cancelled.");
      else if (isRateLimitError(err)) session.fail("The swap service is busy. Try again in a minute.");
      else session.fail(getErrorMessage(err));
    }
  };

  const issue = amountIssue(amountIn, decimalsIn);
  const decision = canSwap({
    sessionActive,
    hasConnector: !!connector,
    liveAmount: amountIn,
    debouncedAmount: debounced,
    amountIssue: issue,
    estimateStatus: estimateQuery.status,
  });

  const estimateError = estimateQuery.error
    ? isRateLimitError(estimateQuery.error)
      ? "The swap service is busy. Try again in a minute."
      : getErrorMessage(estimateQuery.error)
    : null;

  const presentation = swapSession.status === "done" && swapSession.result ? presentSwapResult(swapSession.result) : null;
  const TONE_CLASS = { ok: "text-accent-text", warn: "text-accent-3-text", info: "text-fg" } as const;

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
          <p>{`Max slippage ${slippagePercentLabel(slippageBpsFor(pair.tokenIn, pair.tokenOut))}`}</p>
          {estimateError && <p className="text-accent-3-text">{estimateError}</p>}
          {estimateQuery.data && (
            <>
              <p>
                Minimum received: {estimateQuery.data.stopLimit.amount} {estimateQuery.data.stopLimit.token}
              </p>
              {estimateQuery.data.fees?.map((fee, i) => {
                const isPlatformFee = fee.type === "developer";
                const label = isPlatformFee ? PLATFORM_FEE_LABEL : (FEE_LABEL[fee.type] ?? fee.type);
                const amountText = fee.amount === null ? "unknown" : `${fee.amount} ${fee.token}`;
                return (
                  <p key={i}>
                    {label}: {amountText}
                  </p>
                );
              })}
            </>
          )}
        </div>

        {sessionActive && (
          <p className="mt-3 text-muted">{`Swapping ${swapSession.amountIn} ${swapSession.tokenIn} → ${swapSession.tokenOut}…`}</p>
        )}

        {swapSession.status === "done" && (
          <div className="mt-4 rounded-md border border-border-2 p-3 text-xs">
            {swapSession.result && presentation ? (
              <>
                <p className={`font-medium ${TONE_CLASS[presentation.tone]}`}>{presentation.headline}</p>
                {presentation.reason && <p className="mt-1 text-accent-3-text">{presentation.reason}</p>}
                {presentation.isSuccess && swapSession.result.amountOut && (
                  <p className="mt-1">
                    Received ≈ {swapSession.result.amountOut} {swapSession.result.tokenOut}
                  </p>
                )}
                {presentation.explorerUrl && (
                  <a className="mt-1 block break-all font-mono text-accent-text" href={presentation.explorerUrl} target="_blank" rel="noreferrer">
                    {presentation.txHash}
                  </a>
                )}
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
        <button type="button" disabled={!decision.ok} className="w-full rounded-md border border-border-2 px-3 py-2" onClick={submit}>
          {decision.label}
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
