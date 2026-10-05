"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useConnection } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { AppKit, isRateLimitError } from "@circle-fin/app-kit";
import { explorerUrl } from "@arcos/chain";
import { useDesktop } from "@arcos/shell";
import { BalanceLine } from "@/components/BalanceLine";
import { ConnectGate } from "@/components/ConnectGate";
import { trackEvent } from "@/lib/analytics";
import { ARC_CHAIN_NAME, SWAP_FEE_BPS, SWAP_TOKENS, SWAP_TOKEN_DECIMALS, adapterFor, feePercentLabel, feeRecipient } from "@/lib/appkit";
import { amountIssue, normalizedAmount } from "@/lib/amount";
import { ARC_GAS_RESERVE_UNITS, overBalanceIssue } from "@/lib/balance";
import { useArcTokenBalance } from "@/lib/useArcTokenBalance";
import { useWaitedTooLong } from "@/lib/wallet-wait";
import { canSwap } from "./canSwap";
import { presentSwapResult } from "./presentResult";
import { STOPPED_WAITING_MESSAGE, WALLET_WAIT_MESSAGE, classifySwapFailure, locksForm, session } from "./session";
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
  const { address, connector } = useConnection();
  const { notify } = useDesktop();
  const kit = useMemo(() => new AppKit(), []);

  const swapSession = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const sessionActive = locksForm(swapSession);
  // `kit.swap()` has no bound on the wallet's side, so after a while the window says so and offers "Stop waiting".
  const waitedTooLong = useWaitedTooLong(sessionActive ? swapSession.runId : null, swapSession.startedAt);

  const [pair, setPair] = useState<TokenPair>({ tokenIn: "USDC", tokenOut: "EURC" });
  const [amountIn, setAmountIn] = useState("");
  const decimalsIn = SWAP_TOKEN_DECIMALS[pair.tokenIn];
  const balanceIn = useArcTokenBalance(pair.tokenIn).units;

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
    const runId = session.start(pair.tokenIn, pair.tokenOut, amount);
    if (runId === null) return; // a swap is already in flight (another click, another window) — do nothing
    try {
      const adapter = await adapterFor(connector);
      const result = await kit.swap(buildParams(adapter, pair.tokenIn, pair.tokenOut, amount, estimateQuery.data.stopLimit.amount));
      // `runId` keeps a run the visitor stopped waiting for from overwriting a newer one. A late result still notifies:
      // a swap that went through is worth knowing about, whichever session the window shows now.
      session.finish(result, runId);
      const presentation = presentSwapResult(result);
      if (presentation.isSuccess) trackEvent("swap_success", { pair: `${pair.tokenIn}-${pair.tokenOut}` });
      notify(presentation.headline, presentation.tone);
    } catch (err) {
      // classifySwapFailure (./session) decides reload / Cancelled / rate-limited / hedged-unknown — see its
      // own doc comment for why the unknown case can't just say "Try again" the way
      // GENERIC_TRANSACTION_ERROR does elsewhere: a swap whose promise rejected AFTER it was actually
      // broadcast (a lost wallet response, a timeout) must not read as "nothing happened".
      session.fail(classifySwapFailure(err), runId);
    }
  };

  const issue = amountIssue(amountIn, decimalsIn) ?? overBalanceIssue(amountIn, decimalsIn, balanceIn);
  const decision = canSwap({
    sessionActive,
    hasConnector: !!connector,
    liveAmount: amountIn,
    debouncedAmount: debounced,
    amountIssue: issue,
    estimateStatus: estimateQuery.status,
  });

  // Never getErrorMessage(estimateQuery.error)'s raw text — same rule as the submit failure above.
  const estimateError = estimateQuery.error
    ? isRateLimitError(estimateQuery.error)
      ? "The swap service is busy. Try again in a minute."
      : "Couldn't estimate this swap. Try again."
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
          <BalanceLine
            units={balanceIn}
            decimals={decimalsIn}
            symbol={pair.tokenIn}
            // USDC is also Arc's gas token, so "Max" leaves a little of it for the approval and the swap. The platform fee
            // is taken from what the swap pays out, not added to what it spends, so it doesn't count here.
            max={{ reserveUnits: pair.tokenIn === "USDC" ? ARC_GAS_RESERVE_UNITS : 0n }}
            disabled={sessionActive}
            onMax={setAmountIn}
          />

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

        {sessionActive && waitedTooLong && (
          <div className="mt-3 rounded-md border border-border-2 p-3 text-xs" role="status">
            <p>{WALLET_WAIT_MESSAGE}</p>
            <button
              type="button"
              className="mt-2 rounded-md border border-border-2 px-2 py-1"
              onClick={() => session.stop(swapSession.runId)}
            >
              Stop waiting
            </button>
          </div>
        )}

        {swapSession.status === "stopped" && (
          <div className="mt-4 rounded-md border border-border-2 p-3 text-xs" role="status">
            <p className="text-accent-3-text">{STOPPED_WAITING_MESSAGE}</p>
            {address && (
              <a className="mt-1 block text-accent-text" href={explorerUrl("address", address)} target="_blank" rel="noreferrer">
                Your address in the explorer
              </a>
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
