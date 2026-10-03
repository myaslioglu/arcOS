"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { useConnection } from "wagmi";
import { AppKit, isRetryableError, type BridgeResult, type BridgeStep } from "@circle-fin/app-kit";
import type { Hex } from "viem";
import { USDC_DECIMALS } from "@arcos/chain";
import { useDesktop, type Tone } from "@arcos/shell";
import { BalanceLine } from "@/components/BalanceLine";
import { ConnectGate } from "@/components/ConnectGate";
import { trackEvent } from "@/lib/analytics";
import { amountIssue, normalizedAmount } from "@/lib/amount";
import { ARC_CHAIN_NAME, SWAP_FEE_BPS, adapterFor, bridgeFee, feePercentLabel, feeRecipient } from "@/lib/appkit";
import { ARC_GAS_RESERVE_UNITS, overBalanceIssue } from "@/lib/balance";
import { bridgeChainInfo, bridgeChainOptions, chainLabel, type ChainId } from "./chains";
import {
  FINISH_ALREADY_DONE,
  FINISH_NOT_FOUND,
  FINISH_PENDING,
  FINISH_UNKNOWN_DESTINATION,
  FinishError,
  describeFinishFailure,
  destinationSource,
  explorerTxUrl,
  isDelivered,
  lookupBurn,
  normalizeBurnHash,
  sameNetwork,
  sendMint,
} from "./finish";
import { finishSession } from "./finishSession";
import { explorerCheckNote, fundsLeftSource, inFlightNote } from "./inFlight";
import { resolveRoute, type Direction } from "./route";
import { classifyBridgeFailure, describeStepError, describeWarning, session, type BridgeFailureSource } from "./session";
import { burnStepOf, unfinished, unfinishedFromResult, type UnfinishedTransfer } from "./unfinished";
import { useSourceBalance } from "./useSourceBalance";

const STATE_LABEL: Record<string, string> = {
  success: "Bridge complete",
  pending: "Still finishing on the destination chain",
  error: "The bridge stopped before finishing",
};
const STATE_TONE: Record<string, Tone> = { success: "ok", pending: "info", error: "warn" };

/** Renders one BridgeResult's state, "funds are in flight" note, warnings and step list — shared
 * between the live "done" panel and the read-only evidence shown for `lastResult` (item 8: a retry
 * must not make the original attempt's steps/tx links disappear while it's in progress, or after a
 * retry that itself throws before returning a new result). */
/** Where a step ran, for its error line: the destination for a mint, the source for everything else. */
function stepChain(result: BridgeResult, step: BridgeStep): BridgeFailureSource {
  const chain = /mint/i.test(step.name) ? result.destination.chain : result.source.chain;
  return { label: chainLabel(chain.chain as ChainId), gasSymbol: chain.nativeCurrency.symbol };
}

function BridgeResultSteps({ result }: { result: BridgeResult }) {
  const note =
    result.state === "error" ? inFlightNote(result.source.chain.name, result.destination.chain.name, fundsLeftSource(result.steps)) : null;
  return (
    <>
      <p className={`font-medium ${STATE_TONE[result.state] === "warn" ? "text-accent-3-text" : "text-accent-text"}`}>
        {STATE_LABEL[result.state] ?? result.state}
      </p>
      {note && <p className="mt-1">{note}</p>}
      {result.warnings?.map((w, i) => (
        <p key={i} className="mt-1 text-accent-3-text">
          {describeWarning(w)}
        </p>
      ))}
      <ul className="mt-1 grid gap-1">
        {result.steps.map((step, i) => (
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
            {(step.error !== undefined || step.errorMessage) && step.state === "error" && (
              <span className="text-accent-3-text"> — {describeStepError(step, stepChain(result, step))}</span>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

/** The source chain as a balance failure names it: its label and the token that pays for gas there. */
function failureSource(chain: ChainId): BridgeFailureSource {
  return { label: chainLabel(chain), gasSymbol: bridgeChainInfo(chain)?.gasSymbol ?? "gas token" };
}

/** A hash shortened for a list row: 0x7bd2…8c90f. */
const shortHash = (hash: string) => `${hash.slice(0, 6)}…${hash.slice(-5)}`;

function Form() {
  const { connector } = useConnection();
  const { notify } = useDesktop();
  const kit = useMemo(() => new AppKit(), []);

  const bridgeSession = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const sessionActive = bridgeSession.status === "bridging";
  const finishState = useSyncExternalStore(finishSession.subscribe, finishSession.getSnapshot, finishSession.getSnapshot);
  const finishing = finishState.status === "working";
  const stored = useSyncExternalStore(unfinished.subscribe, unfinished.getSnapshot, unfinished.getServerSnapshot);
  // Only this network's: an entry stored while on the other network isn't offered here, where it couldn't be looked up.
  const unfinishedHere = useMemo(() => stored.filter((t) => sameNetwork(t.source) && sameNetwork(t.dest)), [stored]);
  // Any wallet write at a time, a bridge or a finish: both ask the wallet to switch chains and sign.
  const busy = sessionActive || finishing;

  const options = useMemo(() => bridgeChainOptions(), []);
  const [direction, setDirection] = useState<Direction>("toArc");
  // `options` is a fixed 6-entry list (see ./chains) — never empty, so index 0 always exists.
  const [otherChain, setOtherChain] = useState<ChainId>(options[0]!.chain);
  const [amount, setAmount] = useState("");
  const [burnHashInput, setBurnHashInput] = useState("");

  const { source, dest } = resolveRoute(direction, otherChain, ARC_CHAIN_NAME);
  const recipient = feeRecipient();
  // The platform fee is added on top of the amount and paid from the same USDC, so both "Max" and the balance check
  // count it. Without a fee recipient no fee is charged.
  const feeOnTopBps = recipient ? SWAP_FEE_BPS : 0;
  const sourceBalance = useSourceBalance(source);
  const sourceOnArc = source === ARC_CHAIN_NAME;
  const sourceLabel = chainLabel(source);
  const issue =
    amountIssue(amount) ?? overBalanceIssue(amount, USDC_DECIMALS, sourceBalance, { feeOnTopBps, where: sourceLabel });
  const normalized = normalizedAmount(amount);
  const fee = normalized ? bridgeFee(normalized) : "0";
  // Shown to the user — "…" rather than "0" until there's a real amount to price: a fee of 0 reads
  // as "this bridge is free", not "nothing has been typed yet" (quoteTotal's own version of this bug
  // is fixed in apps/drop/useDrop.ts; this is Bridge's).
  const feeText = normalized ? `${fee} USDC` : "…";

  /** Runs `run()` through the shared one-at-a-time session guard, from the initial submit or from a
   * Retry — both a fresh `kit.bridge()` call and `kit.retryBridge()` land here so they share exactly
   * the same start/finish/fail handling. On a thrown error, appends the "check your wallet's chain
   * explorer" note: a promise rejection here can still follow a burn that already landed.
   *
   * `retry` is forwarded to `session.start` unchanged (I4, wave E): it must be `true` only when `run`
   * is actually retrying the attempt `lastResult` describes, so a brand-new transfer never inherits a
   * previous, unrelated bridge's evidence — see session.ts's "start" reducer case for the full why.
   *
   * The burn is remembered in localStorage (./unfinished) the moment the kit reports it done, from the kit's own
   * `bridge.burn` event, and forgotten when the result says the mint landed: a wallet that crashes on the mint, or a
   * page closed during it, keeps the one thing a Finish needs. */
  const performBridge = async (bridgeSource: ChainId, bridgeDest: ChainId, bridgeAmount: string, retry: boolean, run: () => Promise<BridgeResult>) => {
    const started = session.start(bridgeSource, bridgeDest, bridgeAmount, retry);
    if (!started) return; // a bridge is already in flight (another click, another window) — do nothing
    // `start` just set it; the fallback only satisfies the type.
    const startedAt = session.getSnapshot().startedAt ?? 0;
    const route = { source: bridgeSource, dest: bridgeDest, amount: bridgeAmount, startedAt };
    const onBurn = (payload: { values: BridgeStep }) => {
      const burn = burnStepOf([payload.values]);
      if (burn) unfinished.remember({ ...route, burnTxHash: burn.txHash!.toLowerCase() as Hex });
    };
    kit.on("bridge.burn", onBurn);
    try {
      const result = await run();
      const left = unfinishedFromResult(result, route);
      if (left) unfinished.remember(left);
      else {
        const burn = burnStepOf(result.steps);
        if (burn) unfinished.forget(burn.txHash!);
      }
      session.finish(result);
      if (result.state === "success") trackEvent("bridge_success", { from: bridgeSource, to: bridgeDest });
      notify(STATE_LABEL[result.state] ?? "Bridge submitted", STATE_TONE[result.state] ?? "info");
    } catch (err) {
      session.fail(classifyBridgeFailure(err, explorerCheckNote(chainLabel(bridgeSource)), failureSource(bridgeSource)));
    } finally {
      kit.off("bridge.burn", onBurn);
    }
  };

  const submit = async () => {
    if (!connector || normalized === null || busy) return;
    // Not a retry: the form stays usable after a bridge finishes (so a second, unrelated transfer can
    // be submitted without dismissing first) — this path must always start clean, never carrying a
    // previous attempt's evidence forward.
    await performBridge(source, dest, normalized, false, async () => {
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

  // The evidence a Retry click (or the display below) should act on: the CURRENT attempt's result if
  // there is one, else the last attempt that returned one at all — covers a retry that itself threw
  // (session.fail(), no BridgeResult of its own) without losing the ability to retry again from the
  // original failure. See session.ts's `lastResult` doc comment for why `result` alone isn't enough.
  const evidence = bridgeSession.result ?? bridgeSession.lastResult;

  const retry = async () => {
    const failed = evidence;
    if (!connector || !failed || !bridgeSession.source || !bridgeSession.dest || busy) return;
    const retrySource = bridgeSession.source;
    const retryDest = bridgeSession.dest;
    await performBridge(retrySource, retryDest, bridgeSession.amount, true, async () => {
      const adapter = await adapterFor(connector);
      return kit.retryBridge(failed, { from: adapter, to: adapter });
    });
  };

  /**
   * Finishes a transfer from its burn hash (./finish): asks Circle for the message and its attestation, checks the
   * destination chain hasn't received it already, and sends the mint with the connected wallet, whichever wallet that
   * is. `finishSource` is the chain the burn was sent on: the stored entry's, or the form's source for a pasted hash.
   */
  const finish = async (burnTxHash: Hex, finishSource: ChainId) => {
    if (!connector || busy) return;
    if (!finishSession.start(burnTxHash)) return;
    let destination: ChainId | null = null;
    try {
      const lookup = await lookupBurn(finishSource, burnTxHash);
      if (lookup.kind === "none") throw new FinishError(FINISH_NOT_FOUND(chainLabel(finishSource)));
      if (lookup.kind === "pending") throw new FinishError(FINISH_PENDING);
      if (lookup.kind === "unknown-destination") throw new FinishError(FINISH_UNKNOWN_DESTINATION);
      const { burn } = lookup;
      destination = burn.dest;
      finishSession.destination(burn.dest);
      if (await isDelivered(burn.dest, burn.eventNonce)) {
        unfinished.forget(burnTxHash);
        finishSession.delivered();
        notify(FINISH_ALREADY_DONE(chainLabel(burn.dest)), "info");
        return;
      }
      const adapter = await adapterFor(connector);
      const mintTxHash = await sendMint(adapter, finishSource, burn);
      unfinished.forget(burnTxHash);
      finishSession.minted(mintTxHash);
      trackEvent("bridge_success", { from: finishSource, to: burn.dest });
      notify("Transfer finished", "ok");
    } catch (err) {
      finishSession.fail(describeFinishFailure(err, destinationSource(destination ?? dest)));
    }
  };

  const burnHash = normalizeBurnHash(burnHashInput);
  const burnHashIssue = burnHashInput.trim() !== "" && burnHash === null ? "That isn't a transaction hash: 0x and 64 hex characters." : null;
  const canFinish = !busy && !!connector && burnHash !== null;

  const canSubmit = !busy && !!connector && normalized !== null && issue === null;

  // Whether the failed step's own error is one the SDK considers worth retrying — per the SDK's
  // documented pattern (node_modules/@circle-fin/app-kit/index.d.ts ~line 32714): find the step that
  // recorded an error and ask isRetryableError about that error, not about the result as a whole.
  const failedStep = evidence?.steps.find((s) => s.state === "error" && s.error);
  const canRetry =
    bridgeSession.status === "done" &&
    (bridgeSession.result ? bridgeSession.result.state === "error" : bridgeSession.error !== null) &&
    !!failedStep?.error &&
    isRetryableError(failedStep.error) &&
    !finishing;

  const finishDest = finishState.dest;
  const mintLink = finishState.mintTxHash && finishDest ? explorerTxUrl(finishDest, finishState.mintTxHash) : null;

  return (
    <div className="flex h-full flex-col text-sm">
      <div className="min-h-0 flex-1 overflow-auto p-5">
        <div className="inline-flex rounded-md border border-border-2 p-0.5">
          <button
            type="button"
            aria-pressed={direction === "toArc"}
            disabled={busy}
            className={`rounded px-2 py-1 ${direction === "toArc" ? "bg-surface-2" : ""}`}
            onClick={() => setDirection("toArc")}
          >
            To Arc
          </button>
          <button
            type="button"
            aria-pressed={direction === "fromArc"}
            disabled={busy}
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
            disabled={busy}
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
            disabled={busy}
            placeholder="0.00"
            inputMode="decimal"
            onChange={(e) => setAmount(e.target.value)}
            aria-label="Amount to bridge"
            aria-invalid={!!issue}
          />
          {issue && <span className="mt-1 block text-xs text-accent-3-text">{issue}</span>}
        </label>
        <BalanceLine
          units={sourceBalance}
          decimals={USDC_DECIMALS}
          symbol="USDC"
          where={sourceLabel}
          // On Arc, USDC also pays for the approval and the burn, so "Max" leaves a little for gas there.
          max={{ feeOnTopBps, reserveUnits: sourceOnArc ? ARC_GAS_RESERVE_UNITS : 0n }}
          disabled={busy}
          onMax={setAmount}
        />

        {recipient && (
          <p className="mt-3 text-xs text-muted">
            Fee {feeText} ({feePercentLabel(SWAP_FEE_BPS)}) · added on top
          </p>
        )}

        {sessionActive && (
          <>
            <p className="mt-3 text-muted">
              Bridging — this can take a few minutes. You can close this window; the bridge continues.
            </p>
            {bridgeSession.lastResult && (
              <div className="mt-3 rounded-md border border-border-2 p-3 text-xs">
                <p className="mb-1 text-muted">Retrying. Your first attempt:</p>
                <BridgeResultSteps result={bridgeSession.lastResult} />
              </div>
            )}
          </>
        )}

        {bridgeSession.status === "done" && (
          <div className="mt-4 rounded-md border border-border-2 p-3 text-xs">
            {bridgeSession.result ? (
              <BridgeResultSteps result={bridgeSession.result} />
            ) : (
              <>
                <p className="text-accent-3-text">{bridgeSession.error}</p>
                {bridgeSession.lastResult && (
                  <div className="mt-2">
                    <p className="mb-1 text-muted">Your attempt before this:</p>
                    <BridgeResultSteps result={bridgeSession.lastResult} />
                  </div>
                )}
              </>
            )}
            {canRetry && (
              <button type="button" className="mt-2 rounded-md border border-border-2 px-2 py-1" onClick={retry}>
                Retry
              </button>
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

        <section className="mt-5 border-t border-border pt-4" aria-labelledby="bridge-finish-title">
          <h2 id="bridge-finish-title" className="font-medium">
            Finish a transfer
          </h2>
          <p className="mt-1 text-xs text-muted">
            A bridge that burned your USDC but didn&apos;t mint it on the other side can be finished here, with any wallet: the USDC
            goes to the address it was sent to.
          </p>

          {unfinishedHere.length > 0 && (
            <ul className="mt-3 grid gap-2" aria-label="Unfinished transfers">
              {unfinishedHere.map((t: UnfinishedTransfer) => (
                <li key={t.burnTxHash} className="flex items-center justify-between gap-2 rounded-md border border-border-2 p-2 text-xs">
                  <span>
                    {t.amount} USDC, {chainLabel(t.source)} → {chainLabel(t.dest)}
                    <br />
                    <span className="font-mono text-muted" title={t.burnTxHash}>
                      {shortHash(t.burnTxHash)}
                    </span>
                  </span>
                  <button
                    type="button"
                    disabled={busy || !connector}
                    className="rounded-md border border-border-2 px-2 py-1"
                    onClick={() => finish(t.burnTxHash, t.source)}
                    aria-label={`Finish the transfer ${shortHash(t.burnTxHash)}`}
                  >
                    Finish
                  </button>
                </li>
              ))}
            </ul>
          )}

          <label className="mt-3 block">
            <span className="text-xs text-muted">Burn transaction hash on {sourceLabel}</span>
            <input
              className="mt-1 w-full rounded-md border border-border-2 bg-surface px-2 py-1.5 font-mono"
              value={burnHashInput}
              disabled={busy}
              placeholder="0x…"
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setBurnHashInput(e.target.value)}
              aria-label="Burn transaction hash"
              aria-invalid={!!burnHashIssue}
            />
            {burnHashIssue && <span className="mt-1 block text-xs text-accent-3-text">{burnHashIssue}</span>}
          </label>
          <p className="mt-1 text-xs text-muted">
            Pick the direction above so {sourceLabel} is the chain the USDC left. The burn is the second transaction of the bridge, after the approval.
          </p>
          <button
            type="button"
            disabled={!canFinish}
            className="mt-2 rounded-md border border-border-2 px-3 py-1.5"
            onClick={() => burnHash && finish(burnHash, source)}
          >
            {finishing ? "Finishing…" : "Finish transfer"}
          </button>

          {finishing && <p className="mt-2 text-xs text-muted">Asking Circle for the attestation, then your wallet for the mint…</p>}

          {finishState.status === "done" && (
            <div className="mt-3 rounded-md border border-border-2 p-3 text-xs">
              {finishState.error ? (
                <p className="text-accent-3-text">{finishState.error}</p>
              ) : finishState.alreadyDelivered ? (
                <p>{FINISH_ALREADY_DONE(finishDest ? chainLabel(finishDest) : "the destination chain")}</p>
              ) : (
                <>
                  <p className="font-medium text-accent-text">Transfer finished</p>
                  {finishState.mintTxHash && (
                    <p className="mt-1">
                      Mint on {finishDest ? chainLabel(finishDest) : "the destination chain"}:{" "}
                      {mintLink ? (
                        <a className="break-all font-mono text-accent-text" href={mintLink} target="_blank" rel="noreferrer">
                          {finishState.mintTxHash}
                        </a>
                      ) : (
                        <span className="break-all font-mono">{finishState.mintTxHash}</span>
                      )}
                    </p>
                  )}
                </>
              )}
              <button
                type="button"
                className="mt-2 rounded-md border border-border-2 px-2 py-1"
                onClick={() => {
                  finishSession.dismiss();
                  if (!finishState.error) setBurnHashInput("");
                }}
              >
                Done
              </button>
            </div>
          )}
        </section>
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
  // Any network: the kit switches the wallet to the source chain for the burn and to the destination chain for the mint,
  // so a bridge, or a finish, leaves the wallet off Arc by design. See ConnectGate.
  return (
    <ConnectGate anyNetwork>
      <Form />
    </ConnectGate>
  );
}
