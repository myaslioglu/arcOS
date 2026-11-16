"use client";

import { useId, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useBalance } from "wagmi";
import { getAddress, isAddress, type Address } from "viem";
import { POSITION_MANAGERS, activeChain, activeNetwork, explorerUrl } from "@arcos/chain";
import { useDesktop } from "@arcos/shell";
import { BalanceLine } from "@/components/BalanceLine";
import { notifyBalanceChanged } from "@/lib/balance-refresh";
import { INSUFFICIENT_FUNDS_ERROR } from "@/lib/contract-error";
import { displayUnits, displayWei } from "@/lib/display-amount";
import { formatTokenAmount } from "@/lib/amount";
import { pairText, positionIssue, positionLabel, type Position } from "@/lib/positions";
import { POSITIONS_KEY, useAllowedManagers, usePositions } from "@/lib/usePositions";
import { CUSTODY_POSITION, CUSTODY_TOKEN } from "./copy";
import { MANAGER_NOT_ALLOWED } from "./errors";
import { flatFeeLine, lpFeeLine, shareFeeLine } from "./fees";
import { runLock, type LockPlan } from "./flow";
import { LOCKS_KEY, TOKEN_KEY, useChainClock, useFlowDeps, useLockFees, usePositionInfo, useTokenInfo } from "./hooks";
import {
  PRESET_DAYS,
  checkAmount,
  checkUnlock,
  dateBounds,
  formatWhen,
  lockReserve,
  presetUnlock,
  unlockFromDate,
  untilText,
} from "./lockForm";
import { isBusy, vaultSession, type LockSummary } from "./session";
import type { Target } from "./target";
import { BUTTON, INPUT, PICKED } from "./ui";

/** What a drop or the window's params put in the form; `seq` tells two drops of the same thing apart. */
export type Prefill = { target: Exclude<Target, { kind: "vault" }>; seq: number };

type When = { kind: "preset"; days: number } | { kind: "date"; value: string };


const OTHER = "other";

const unlockOf = (when: When | null, now: number): number | null =>
  when === null ? null : when.kind === "preset" ? presetUnlock(now, when.days) : unlockFromDate(when.value, now);

type Props = { factory: Address; wallet: Address; prefill: Prefill | null; onShowLocks: () => void };

/**
 * The New lock form: a token (an ERC-20 or a Uniswap v2 LP token) or a position, an unlock date, the fee, and the
 * lock itself (flow.ts's runLock, through the session store, so it survives the window closing).
 */
export function NewLock({ factory, wallet, prefill, onShowLocks }: Props) {
  const network = activeNetwork();
  const chain = activeChain();
  const { open } = useDesktop();
  const queryClient = useQueryClient();
  const clock = useChainClock();
  const fees = useLockFees(factory);
  const deps = useFlowDeps();
  const native = useBalance({ address: wallet, chainId: chain.id });
  const session = useSyncExternalStore(vaultSession.subscribe, vaultSession.getSnapshot, vaultSession.getSnapshot);
  const busy = isBusy(session);
  const lock = session.lock;

  const [mode, setMode] = useState<"token" | "position">("token");
  const [tokenText, setTokenText] = useState("");
  const [amountText, setAmountText] = useState("");
  const [managerSel, setManagerSel] = useState("");
  const [otherManager, setOtherManager] = useState("");
  const [idText, setIdText] = useState("");
  const [when, setWhen] = useState<When | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ids = { token: useId(), amount: useId(), manager: useId(), other: useId(), id: useId(), date: useId() };

  // A drop, or new params, fills the form: a state adjusted during the render, once per prefill.
  const [seenPrefill, setSeenPrefill] = useState<Prefill | null>(null);
  if (prefill !== seenPrefill) {
    setSeenPrefill(prefill);
    if (prefill) {
      const t = prefill.target;
      setError(null);
      if (t.kind === "token") {
        setMode("token");
        setTokenText(t.token);
        setAmountText("");
      } else {
        const known = POSITION_MANAGERS[network].some((m) => m.address.toLowerCase() === t.manager.toLowerCase());
        setMode("position");
        setManagerSel(known ? t.manager : OTHER);
        setOtherManager(known ? "" : t.manager);
        setIdText(t.tokenId);
      }
    }
  }

  const allowed = useAllowedManagers(factory);
  const positions = usePositions(mode === "position" ? wallet : undefined, factory);
  const effectiveSel = managerSel || allowed.data?.[0]?.address || OTHER;
  const managerText = effectiveSel === OTHER ? otherManager.trim() : effectiveSel;
  const manager = isAddress(managerText, { strict: false }) ? getAddress(managerText) : null;
  const tokenId = /^(0|[1-9]\d{0,77})$/.test(idText.trim()) ? BigInt(idText.trim()) : null;
  const token = isAddress(tokenText.trim(), { strict: false }) ? getAddress(tokenText.trim()) : null;

  const info = useTokenInfo(mode === "token" ? token : null, wallet, factory);
  const position = usePositionInfo(mode === "position" ? manager : null, tokenId, wallet, factory);
  const tokenData = info.data && !("error" in info.data) ? info.data : null;

  const now = clock.now;
  const unlockAt = unlockOf(when, now);
  const unlock = checkUnlock(unlockAt, now);
  const bounds = dateBounds(now);
  const amount = tokenData && amountText.trim() ? checkAmount(amountText, tokenData.decimals, tokenData.balance ?? undefined) : null;

  const set = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v);
    setError(null);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (busy) return;
    if (!deps) return setError("Your wallet isn't ready. Try again.");
    if (!fees.data) {
      void fees.refetch();
      return setError("Couldn't read the fee. Try again.");
    }
    const at = clock.at(Date.now());
    const check = checkUnlock(unlockOf(when, at), at);
    if (!check.ok) return setError(check.error);
    let plan: LockPlan;
    let summary: LockSummary;
    if (mode === "token") {
      if (!token) return setError("Enter the token's address.");
      if (!info.data) return setError("Still reading the token. Try again in a moment.");
      if ("error" in info.data) return setError(info.data.error);
      const a = checkAmount(amountText, info.data.decimals, info.data.balance ?? undefined);
      if (!a.ok) return setError(a.error);
      plan = { kind: "token", token, amount: a.units, unlockAt: check.unlockAt };
      summary = { kind: "token", label: `${displayUnits(a.units, info.data.decimals)} ${info.data.symbol}`, unlockAt: check.unlockAt };
    } else {
      if (!manager || tokenId === null) return setError("Pick a position, or type its id.");
      const p = position.data;
      if (!p) return setError("Still reading the position. Try again in a moment.");
      if (!p.manager) return setError(MANAGER_NOT_ALLOWED);
      if (p.position === null) return setError("There is no position with that id.");
      if (p.position === "not-yours") return setError("This position belongs to another wallet.");
      const issue = positionIssue(p.position);
      if (issue) return setError(issue);
      plan = { kind: "position", manager, tokenId, unlockAt: check.unlockAt };
      summary = { kind: "position", label: positionLabel(p.position), unlockAt: check.unlockAt };
    }
    if (native.data && native.data.value < fees.data.flat) return setError(INSUFFICIENT_FUNDS_ERROR);
    const fee = fees.data.flat;
    const run = vaultSession.startLock(summary, (onStep) => runLock(plan, factory, fee, deps, onStep));
    if (!run) return;
    void run.finally(() => {
      // Gas is spent whatever the outcome: every balance, list and allowance shown is read again.
      notifyBalanceChanged();
      for (const key of [LOCKS_KEY, TOKEN_KEY, POSITIONS_KEY, "vault-position"]) void queryClient.invalidateQueries({ queryKey: [key] });
    });
  };

  if (lock.status === "running") {
    const { summary, step, sent } = lock;
    const text =
      step === "approve"
        ? sent
          ? "Waiting for the approval to confirm…"
          : `Approve ${summary.label} for the vault factory in your wallet…`
        : sent
          ? "Waiting for the lock to confirm…"
          : `Confirm the lock in your wallet. It sends the ${fees.data ? displayWei(fees.data.flat, "up") : ""} USDC fee.`;
    return (
      <div className="grid gap-2" role="status" aria-live="polite">
        <p className="font-medium">{`Locking ${summary.label} until ${formatWhen(summary.unlockAt)}`}</p>
        <p>{text}</p>
        <p className="text-xs text-muted">Keep this tab open until it finishes. You can close this window; the lock continues.</p>
      </div>
    );
  }

  if (lock.status === "done") {
    const { outcome, summary } = lock;
    if (outcome.result === "locked") {
      return (
        <div className="grid gap-3" role="status">
          <p className="text-base font-medium">Locked</p>
          <p>{`${summary.label} is in its vault until ${formatWhen(summary.unlockAt)}.`}</p>
          <p className="text-xs">
            {"Vault "}
            <a className="font-mono text-accent-text underline" href={explorerUrl("address", outcome.vault)} target="_blank" rel="noopener noreferrer">
              {outcome.vault}
            </a>
          </p>
          <p className="text-xs">
            <a className="text-accent-text underline" href={explorerUrl("tx", outcome.hash)} target="_blank" rel="noopener noreferrer">
              View the transaction on the explorer
            </a>
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={BUTTON} onClick={onShowLocks}>
              See Your locks
            </button>
            <button type="button" className={BUTTON} onClick={() => vaultSession.dismissLock()}>
              Lock something else
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="grid gap-3">
        <p className="text-danger-text" role="alert">
          {outcome.message}
        </p>
        {outcome.hash && (
          <p className="text-xs">
            <a className="text-accent-text underline" href={explorerUrl("tx", outcome.hash)} target="_blank" rel="noopener noreferrer">
              View the transaction on the explorer
            </a>
          </p>
        )}
        {outcome.result === "failed" && outcome.approvalLeft && (
          <p className="text-xs text-muted">
            {"The approval you gave the vault factory is still set. "}
            <button type="button" className="text-accent-text underline" onClick={() => open("revoke")}>
              Revoke can remove it.
            </button>
          </p>
        )}
        <div>
          <button type="button" className={BUTTON} onClick={() => vaultSession.dismissLock()}>
            {outcome.result === "unconfirmed" ? "I checked. Start a new lock" : "Try again"}
          </button>
        </div>
      </div>
    );
  }

  const fee = fees.data;
  const p = position.data?.position;
  const positionShown = p && p !== "not-yours" ? p : null;
  const picked = (x: Position) => manager !== null && x.manager.toLowerCase() === manager.toLowerCase() && tokenId !== null && x.tokenId === tokenId.toString();

  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      <div className="inline-flex w-fit rounded-md border border-border-2 p-0.5" role="group" aria-label="What to lock">
        {(["token", "position"] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            className={`min-h-8 rounded px-3 text-xs pointer-coarse:min-h-11 ${mode === m ? "bg-surface-2" : ""}`}
            onClick={() => set(setMode)(m)}
          >
            {m === "token" ? "Token or LP token" : "Position"}
          </button>
        ))}
      </div>
      <p className="-mt-2 text-xs text-muted">Drop a token or a position from Finder here, or type it below.</p>

      {mode === "token" ? (
        <div className="grid gap-3">
          <label className="grid gap-1" htmlFor={ids.token}>
            <span className="text-xs text-muted">Token address</span>
            <input
              id={ids.token}
              className={INPUT}
              value={tokenText}
              placeholder="0x…"
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => set(setTokenText)(e.target.value)}
            />
          </label>
          {tokenText.trim() !== "" && !token && <p className="text-xs text-danger-text">{"That isn't an address."}</p>}
          {token && info.isPending && <p className="text-xs text-muted">Reading the token…</p>}
          {token && info.isError && <p className="text-xs text-danger-text">{"Couldn't read this token. Try again."}</p>}
          {info.data && "error" in info.data && <p className="text-xs text-danger-text">{info.data.error}</p>}
          {tokenData && (
            <>
              <p className="text-xs">
                <span className="font-medium">{tokenData.symbol}</span>
                {tokenData.name ? ` · ${tokenData.name}` : ""}
                {tokenData.pair ? ` · Uniswap v2 LP token for ${tokenData.pair.symbol0}/${tokenData.pair.symbol1}` : ""}
              </p>
              <div className="grid gap-1">
                <label className="grid gap-1" htmlFor={ids.amount}>
                  <span className="text-xs text-muted">Amount</span>
                  <input
                    id={ids.amount}
                    className={INPUT}
                    value={amountText}
                    inputMode="decimal"
                    placeholder="0"
                    autoComplete="off"
                    aria-invalid={amount !== null && !amount.ok}
                    onChange={(e) => set(setAmountText)(e.target.value)}
                  />
                </label>
                {tokenData.balance !== null && (
                  <BalanceLine
                    units={tokenData.balance}
                    max={{ reserveUnits: lockReserve(tokenData.address, fee?.flat) }}
                    decimals={tokenData.decimals}
                    symbol={tokenData.symbol}
                    onMax={(text) => set(setAmountText)(text)}
                  />
                )}
                {amount && !amount.ok && <p className="text-xs text-danger-text">{amount.error}</p>}
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="grid gap-3">
          <PositionPicker
            loading={positions.isPending}
            failed={positions.isError}
            list={positions.data?.positions ?? []}
            isPicked={picked}
            onPick={(x) => {
              setManagerSel(x.manager);
              setOtherManager("");
              setIdText(x.tokenId);
              setError(null);
            }}
          />
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
            <label className="grid gap-1" htmlFor={ids.manager}>
              <span className="text-xs text-muted">Manager</span>
              <select
                id={ids.manager}
                className={`${INPUT} font-sans`}
                value={effectiveSel}
                onChange={(e) => set(setManagerSel)(e.target.value)}
              >
                {(allowed.data ?? []).map((m) => (
                  <option key={m.address} value={m.address}>
                    {m.name}
                  </option>
                ))}
                <option value={OTHER}>Other address…</option>
              </select>
            </label>
            <label className="grid gap-1" htmlFor={ids.id}>
              <span className="text-xs text-muted">Position id</span>
              <input
                id={ids.id}
                className={INPUT}
                value={idText}
                inputMode="numeric"
                placeholder="123456"
                autoComplete="off"
                onChange={(e) => set(setIdText)(e.target.value)}
              />
            </label>
          </div>
          {effectiveSel === OTHER && (
            <label className="grid gap-1" htmlFor={ids.other}>
              <span className="text-xs text-muted">Manager address</span>
              <input
                id={ids.other}
                className={INPUT}
                value={otherManager}
                placeholder="0x…"
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => set(setOtherManager)(e.target.value)}
              />
            </label>
          )}
          {idText.trim() !== "" && tokenId === null && <p className="text-xs text-danger-text">A position id is a whole number.</p>}
          {manager && tokenId !== null && position.isPending && <p className="text-xs text-muted">Reading the position…</p>}
          {position.isError && <p className="text-xs text-danger-text">{"Couldn't read this position. Try again."}</p>}
          {position.data && !position.data.manager && <p className="text-xs text-danger-text">{MANAGER_NOT_ALLOWED}</p>}
          {position.data?.manager && position.data.position === null && <p className="text-xs text-danger-text">There is no position with that id.</p>}
          {position.data?.position === "not-yours" && <p className="text-xs text-danger-text">This position belongs to another wallet.</p>}
          {positionShown && (
            <p className="text-xs">
              <span className="font-medium">{positionLabel(positionShown)}</span>
              {` · ${pairText(positionShown)}`}
            </p>
          )}
          {positionShown && positionIssue(positionShown) && <p className="text-xs text-danger-text">{positionIssue(positionShown)}</p>}
        </div>
      )}

      <fieldset className="grid gap-2">
        <legend className="text-xs text-muted">Unlock date</legend>
        <div className="flex flex-wrap gap-2">
          {PRESET_DAYS.map((days) => (
            <button
              key={days}
              type="button"
              className={`${BUTTON} ${when?.kind === "preset" && when.days === days ? PICKED : ""}`}
              aria-pressed={when?.kind === "preset" && when.days === days}
              onClick={() => set(setWhen)({ kind: "preset", days })}
            >
              {days === 365 ? "1 year" : `${days} days`}
            </button>
          ))}
          <label className="sr-only" htmlFor={ids.date}>
            Or pick a date
          </label>
          <input
            id={ids.date}
            type="date"
            className="min-h-8 rounded-md border border-border-2 bg-surface px-2 text-xs pointer-coarse:min-h-11"
            min={bounds.min}
            max={bounds.max}
            value={when?.kind === "date" ? when.value : ""}
            onChange={(e) => set(setWhen)(e.target.value ? { kind: "date", value: e.target.value } : null)}
          />
        </div>
        {unlockAt !== null &&
          (unlock.ok ? (
            <p className="text-xs">{`Unlocks ${formatWhen(unlock.unlockAt)} (${untilText(unlock.unlockAt, now)}).`}</p>
          ) : (
            <p className="text-xs text-danger-text">{unlock.error}</p>
          ))}
      </fieldset>

      <div className="grid gap-1 text-xs">
        {fee ? <p>{flatFeeLine(fee.flat)}</p> : fees.isError ? <p className="text-danger-text">{"Couldn't read the fee."}</p> : <p className="text-muted">Reading the fee…</p>}
        {fee && mode === "token" && tokenData?.pair && (
          <p>{lpFeeLine(fee.lpBps, amount?.ok ? amount.units : null, tokenData.decimals, tokenData.symbol)}</p>
        )}
        {fee && mode === "position" && <p>{shareFeeLine(fee.shareBps)}</p>}
        {fee && mode === "token" && tokenData?.allowance !== null && tokenData?.allowance !== undefined && amount?.ok && tokenData.allowance < amount.units && (
          <p className="text-muted">{`Your wallet asks twice: first to approve exactly ${formatTokenAmount(amount.units, tokenData.decimals)} ${tokenData.symbol}, then to lock.`}</p>
        )}
      </div>

      <p className="text-xs text-muted">{mode === "token" ? CUSTODY_TOKEN : CUSTODY_POSITION}</p>

      {error && (
        <p className="text-xs text-danger-text" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="min-h-9 rounded-md border border-border-2 px-3 py-2 disabled:opacity-50" disabled={busy}>
        {busy ? "Another Vault transaction is under way…" : `Lock · ${fee ? displayWei(fee.flat, "up") : "…"} USDC`}
      </button>
    </form>
  );
}

function PositionPicker({
  loading,
  failed,
  list,
  isPicked,
  onPick,
}: {
  loading: boolean;
  failed: boolean;
  list: readonly Position[];
  isPicked: (p: Position) => boolean;
  onPick: (p: Position) => void;
}) {
  if (loading) return <p className="text-xs text-muted">Reading your positions…</p>;
  if (failed) return <p className="text-xs text-muted">{"Couldn't list your positions. Type a position's id below."}</p>;
  if (list.length === 0) return <p className="text-xs text-muted">No positions found in the managers Vault takes. Type a position&apos;s id below.</p>;
  return (
    <ul className="grid max-h-40 gap-1 overflow-auto" aria-label="Your positions">
      {list.map((p) => {
        const issue = positionIssue(p);
        return (
          <li key={`${p.manager}:${p.tokenId}`}>
            <button
              type="button"
              aria-pressed={isPicked(p)}
              className={`w-full rounded-md border border-border px-2 py-1.5 text-left text-xs ${isPicked(p) ? "bg-surface-2" : ""}`}
              onClick={() => onPick(p)}
            >
              <span className="font-medium">{positionLabel(p)}</span>
              {` · ${pairText(p)}`}
              {issue && <span className="block text-muted">{issue}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
