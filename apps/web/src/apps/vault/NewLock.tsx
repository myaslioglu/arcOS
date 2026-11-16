"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
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
import { flatFeeLine, lpFeeLine, raiseLine, shareFeeLine } from "./fees";
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
import { lockStepText, lockedText } from "./notes";
import { isBusy, vaultSession, type LockSummary } from "./session";
import type { Target } from "./target";
import { BUTTON, DATE_INPUT, INPUT, PICKED, invalid } from "./ui";

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

  const rootRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  // The submit button unmounts when a lock starts, the progress when it ends, the result when it is dismissed: focus
  // moves to what took their place (the status, or the form's first control) when it was in here or fell to the page,
  // never away from another window. Only on a change: a window reopened mid-lock keeps the focus it was given.
  const lastStatus = useRef(lock.status);
  useEffect(() => {
    if (lastStatus.current === lock.status) return;
    lastStatus.current = lock.status;
    const active = document.activeElement;
    if (active && active !== document.body && !rootRef.current?.contains(active)) return;
    if (lock.status === "idle") rootRef.current?.querySelector<HTMLElement>("form button, form input")?.focus();
    else statusRef.current?.focus();
  }, [lock.status]);

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
      const { symbol, decimals } = info.data;
      plan = { kind: "token", token, amount: a.units, unlockAt: check.unlockAt, pair: !!info.data.pair };
      // The approval is for the whole amount, as the wallet shows it; what reaches the vault (less an LP token's share,
      // or a token's own cut) comes from the factory's event once the lock is mined.
      summary = {
        kind: "token",
        label: `${displayUnits(a.units, decimals, "down")} ${symbol}`,
        approval: `${formatTokenAmount(a.units, decimals)} ${symbol}`,
        unlockAt: check.unlockAt,
        fee: fees.data.flat,
        token: { symbol, decimals },
      };
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
      const label = positionLabel(p.position);
      summary = { kind: "position", label, approval: label, unlockAt: check.unlockAt, fee: fees.data.flat };
    }
    if (native.data && native.data.value < fees.data.flat) return setError(INSUFFICIENT_FUNDS_ERROR);
    // The fees as the form shows them: runLock reads them again before each wallet step and stops if one this lock pays
    // has changed.
    const shown = { flat: fees.data.flat, lpBps: fees.data.lpBps, shareBps: fees.data.shareBps };
    const run = vaultSession.startLock(summary, (onStep) => runLock(plan, factory, shown, deps, onStep));
    if (!run) return;
    void run.finally(() => {
      // Gas is spent whatever the outcome: every balance, list and allowance shown is read again.
      notifyBalanceChanged();
      for (const key of [LOCKS_KEY, TOKEN_KEY, POSITIONS_KEY, "vault-position"]) void queryClient.invalidateQueries({ queryKey: [key] });
    });
  };

  // What the visitor hears: one live region, always mounted, says each step and the outcome (a region mounted along
  // with its text is often not read out).
  let live = "";
  let status: ReactNode = null;
  if (lock.status === "running") {
    const { summary, step, sent } = lock;
    const heading = `Locking ${summary.label} until ${formatWhen(summary.unlockAt)}`;
    const text = lockStepText(summary, step, sent);
    live = `${heading}. ${text}`;
    status = (
      <div className="grid gap-2 outline-none" ref={statusRef} tabIndex={-1}>
        <p className="font-medium">{heading}</p>
        <p>{text}</p>
        <p className="text-xs text-muted">Keep this tab open until it finishes. You can close this window; the lock continues.</p>
      </div>
    );
  } else if (lock.status === "done") {
    const { outcome, summary } = lock;
    if (outcome.result === "locked") {
      const text = lockedText(summary, outcome);
      live = `Locked. ${text}`;
      status = (
        <div className="grid gap-3 outline-none" ref={statusRef} tabIndex={-1}>
          <p className="text-base font-medium">Locked</p>
          <p>{text}</p>
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
    } else {
      live = outcome.message;
      status = (
        <div className="grid gap-3 outline-none" ref={statusRef} tabIndex={-1}>
          <p className="text-danger-text">{outcome.message}</p>
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
          <div className="flex flex-wrap gap-2">
            {outcome.result === "unconfirmed" && (
              <button type="button" className={BUTTON} onClick={onShowLocks}>
                See Your locks
              </button>
            )}
            <button type="button" className={BUTTON} onClick={() => vaultSession.dismissLock()}>
              {outcome.result === "unconfirmed" ? "I checked. Start a new lock" : "Try again"}
            </button>
          </div>
        </div>
      );
    }
  }

  const fee = fees.data;
  const p = position.data?.position;
  const positionShown = p && p !== "not-yours" ? p : null;
  const picked = (x: Position) => manager !== null && x.manager.toLowerCase() === manager.toLowerCase() && tokenId !== null && x.tokenId === tokenId.toString();

  // Each field's own message, which it points at when it is invalid.
  const tokenError =
    tokenText.trim() !== "" && !token
      ? "That isn't an address."
      : info.data && "error" in info.data
        ? info.data.error
        : token && info.isError
          ? "Couldn't read this token. Try again."
          : null;
  const amountError = amount && !amount.ok ? amount.error : null;
  const managerError =
    effectiveSel === OTHER && otherManager.trim() !== "" && !manager
      ? "That isn't an address."
      : position.data && !position.data.manager
        ? MANAGER_NOT_ALLOWED
        : null;
  const idError =
    idText.trim() !== "" && tokenId === null
      ? "A position id is a whole number."
      : position.isError
        ? "Couldn't read this position. Try again."
        : position.data?.manager && position.data.position === null
          ? "There is no position with that id."
          : position.data?.position === "not-yours"
            ? "This position belongs to another wallet."
            : positionShown
              ? positionIssue(positionShown)
              : null;
  // A raise scheduled on a fee this lock would pay: said before the wallet opens.
  const raises = fee
    ? [
        raiseLine("flat", fee.pending.flat, fee.flat, now),
        mode === "token" && tokenData?.pair ? raiseLine("lp", fee.pending.lpBps, fee.lpBps, now) : null,
        mode === "position" ? raiseLine("share", fee.pending.shareBps, fee.shareBps, now) : null,
      ].filter((t): t is string => t !== null)
    : [];

  const form = (
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
              {...invalid(ids.token, tokenError)}
              onChange={(e) => set(setTokenText)(e.target.value)}
            />
          </label>
          {tokenError && (
            <p className="text-xs text-danger-text" id={`${ids.token}-error`}>
              {tokenError}
            </p>
          )}
          {token && info.isPending && <p className="text-xs text-muted">Reading the token…</p>}
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
                    {...invalid(ids.amount, amountError)}
                    onChange={(e) => set(setAmountText)(e.target.value)}
                  />
                </label>
                {tokenData.balance !== null && (
                  <BalanceLine
                    units={tokenData.balance}
                    max={{ reserveUnits: lockReserve(tokenData.address, fee?.flat) }}
                    decimals={tokenData.decimals}
                    symbol={tokenData.symbol}
                    rounded
                    onMax={(text) => set(setAmountText)(text)}
                  />
                )}
                {amountError && (
                  <p className="text-xs text-danger-text" id={`${ids.amount}-error`}>
                    {amountError}
                  </p>
                )}
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
                {...(effectiveSel === OTHER ? {} : invalid(ids.manager, managerError))}
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
                {...invalid(ids.id, idError)}
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
                {...invalid(ids.other, managerError)}
                onChange={(e) => set(setOtherManager)(e.target.value)}
              />
            </label>
          )}
          {managerError && (
            <p className="text-xs text-danger-text" id={`${effectiveSel === OTHER ? ids.other : ids.manager}-error`}>
              {managerError}
            </p>
          )}
          {manager && tokenId !== null && position.isPending && <p className="text-xs text-muted">Reading the position…</p>}
          {positionShown && (
            <p className="text-xs">
              <span className="font-medium">{positionLabel(positionShown)}</span>
              {` · ${pairText(positionShown)}`}
            </p>
          )}
          {idError && (
            <p className="text-xs text-danger-text" id={`${ids.id}-error`}>
              {idError}
            </p>
          )}
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
            className={DATE_INPUT}
            min={bounds.min}
            max={bounds.max}
            value={when?.kind === "date" ? when.value : ""}
            {...invalid(ids.date, when?.kind === "date" && !unlock.ok ? unlock.error : null)}
            onChange={(e) => set(setWhen)(e.target.value ? { kind: "date", value: e.target.value } : null)}
          />
        </div>
        {unlockAt !== null &&
          (unlock.ok ? (
            <p className="text-xs">{`Unlocks ${formatWhen(unlock.unlockAt)} (${untilText(unlock.unlockAt, now)}).`}</p>
          ) : (
            <p className="text-xs text-danger-text" id={`${ids.date}-error`}>
              {unlock.error}
            </p>
          ))}
      </fieldset>

      <div className="grid gap-1 text-xs">
        {fee ? <p>{flatFeeLine(fee.flat)}</p> : fees.isError ? <p className="text-danger-text">{"Couldn't read the fee."}</p> : <p className="text-muted">Reading the fee…</p>}
        {fee && mode === "token" && tokenData?.pair && (
          <p>{lpFeeLine(fee.lpBps, amount?.ok ? amount.units : null, tokenData.decimals, tokenData.symbol)}</p>
        )}
        {fee && mode === "position" && <p>{shareFeeLine(fee.shareBps)}</p>}
        {raises.map((text) => (
          <p key={text} className="text-accent-3-text">
            {text}
          </p>
        ))}
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

  return (
    <div ref={rootRef}>
      <p className="sr-only" role="status" aria-live="polite">
        {live}
      </p>
      {status ?? form}
    </div>
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
