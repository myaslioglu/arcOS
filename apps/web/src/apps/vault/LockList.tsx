"use client";

import { useEffect, useId, useMemo, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getAddress, isAddress, zeroAddress, type Address } from "viem";
import { activeNetwork, explorerUrl } from "@arcos/chain";
import { dragSourceProps } from "@arcos/shell";
import { notifyBalanceChanged } from "@/lib/balance-refresh";
import { displayUnits } from "@/lib/display-amount";
import { shortAddress } from "@/lib/format";
import { POSITIONS_KEY } from "@/lib/usePositions";
import { NOT_YOURS, TRANSFER_NOTE } from "./copy";
import { bpsText } from "./fees";
import { runAction, type VaultAction } from "./flow";
import { LOCKS_KEY, useChainClock, useFlowDeps, useLocks } from "./hooks";
import { checkExtend, dateBounds, extendBase, formatWhen, presetUnlock, unlockFromDate, untilText, PRESET_DAYS } from "./lockForm";
import { groupLocks, isEmpty, isUnlocked, lockDragItem, lockTitle, proofTokens, roleOf, type Lock, type PositionLock, type Role } from "./locks";
import { forgetVault, rememberVault, rememberedSnapshot, subscribeRemembered } from "./remembered";
import { noteText, transferIssue } from "./notes";
import { isBusy, vaultSession, type ActionKind, type ActionNote } from "./session";
import { BUTTON, INPUT, LINK, PICKED } from "./ui";


const NONE: readonly Address[] = [];

const amountText = (units: bigint, decimals: number) => displayUnits(units, decimals, "down");

type Props = {
  factory: Address;
  wallet: Address;
  /** Vaults opened by a drop or the window's params, this session. */
  opened: readonly Address[];
  onOpen: (vault: Address) => void;
};

/** Your locks: every lock the wallet owns or is being handed, with what it can do to each (flow.ts's runAction). */
export function LockList({ factory, wallet, opened, onOpen }: Props) {
  const network = activeNetwork();
  const queryClient = useQueryClient();
  const clock = useChainClock();
  const deps = useFlowDeps();
  const session = useSyncExternalStore(vaultSession.subscribe, vaultSession.getSnapshot, vaultSession.getSnapshot);
  const busy = isBusy(session);
  const remembered = useSyncExternalStore(subscribeRemembered, () => rememberedSnapshot(network, wallet), () => NONE);
  const extra = useMemo(() => [...remembered, ...opened], [remembered, opened]);
  const [pages, setPages] = useState(1);
  const locks = useLocks(wallet, factory, extra, pages);

  // A vault opened here, or accepted, stays listed for this wallet (the factory's registry never will list it); one
  // the wallet has no part in any more is forgotten. Only vaults that were read decide: a failed read changes nothing.
  useEffect(() => {
    for (const lock of locks.data?.locks ?? []) {
      const role = roleOf(lock, wallet);
      const isOpened = opened.some((a) => a.toLowerCase() === lock.vault.toLowerCase());
      const isRemembered = remembered.some((a) => a.toLowerCase() === lock.vault.toLowerCase());
      if (role !== "other" && isOpened && !isRemembered) rememberVault(network, wallet, lock.vault);
      if (role === "other" && isRemembered) forgetVault(network, wallet, lock.vault);
    }
  }, [locks.data, opened, remembered, network, wallet]);

  const act = (lock: Lock, action: VaultAction) => {
    if (!deps || busy) return;
    const run = vaultSession.startAction(lock.vault, action.kind, (onSent) => runAction(lock, action, deps, onSent));
    if (!run) return;
    void run.then((outcome) => {
      if (outcome.result === "done" && action.kind === "accept") rememberVault(network, wallet, lock.vault);
      notifyBalanceChanged();
      void queryClient.invalidateQueries({ queryKey: [LOCKS_KEY] });
      if (lock.kind === "position") void queryClient.invalidateQueries({ queryKey: [POSITIONS_KEY] });
    });
  };

  const groups = locks.data ? groupLocks(locks.data.locks, wallet) : null;
  const opener = <OpenForm onOpen={onOpen} />;

  if (locks.isPending) return <div className="grid gap-4"><p className="text-muted" aria-live="polite">Reading your locks…</p>{opener}</div>;
  if (locks.isError && !locks.data) {
    return (
      <div className="grid gap-4">
        <div className="grid justify-items-start gap-2">
          <p className="text-danger-text" role="alert">
            {"Couldn't read your locks. Try again in a minute."}
          </p>
          <button type="button" className={BUTTON} onClick={() => void locks.refetch()}>
            Try again
          </button>
        </div>
        {opener}
      </div>
    );
  }
  const data = locks.data!;
  const rows = (list: Lock[], role: Role) =>
    list.map((lock) => (
      <LockRow
        key={lock.vault}
        lock={lock}
        role={role}
        now={clock.now}
        busy={busy || !deps}
        running={session.action?.vault === lock.vault.toLowerCase() ? session.action : null}
        note={session.notes[lock.vault.toLowerCase()]}
        onAct={(action) => act(lock, action)}
        nowAt={() => clock.at(Date.now())}
      />
    ));

  return (
    <div className="grid gap-4">
      {locks.isRefetchError && (
        <p className="text-xs text-muted" role="status">
          {"Couldn't refresh your locks. Showing the last list."}
        </p>
      )}
      {data.notVaults.length > 0 && (
        <p className="text-xs text-danger-text" role="alert">
          {`Not an ArcOS vault: ${data.notVaults.map(shortAddress).join(", ")}.`}
        </p>
      )}
      {groups && groups.incoming.length > 0 && (
        <section className="grid gap-2" aria-label="Waiting for you">
          <h3 className="text-xs font-medium text-muted">Waiting for you to accept</h3>
          <ul className="grid gap-2">{rows(groups.incoming, "incoming")}</ul>
        </section>
      )}
      <section className="grid gap-2" aria-label="Your locks">
        {groups && groups.owner.length > 0 ? (
          <ul className="grid gap-2">{rows(groups.owner, "owner")}</ul>
        ) : (
          <p className="text-muted">No locks yet. Lock a token or a position in New lock.</p>
        )}
        {data.registered > data.readFromRegistry && (
          <button type="button" className={`${BUTTON} w-fit`} onClick={() => setPages((n) => n + 1)}>
            {`Show older locks (${data.registered - data.readFromRegistry} more)`}
          </button>
        )}
      </section>
      {groups && groups.empty.length > 0 && (
        <section className="grid gap-2" aria-label="Withdrawn">
          <h3 className="text-xs font-medium text-muted">Withdrawn</h3>
          <ul className="grid gap-2">{rows(groups.empty, "owner")}</ul>
        </section>
      )}
      {groups && groups.other.length > 0 && (
        <section className="grid gap-2" aria-label="Not yours">
          <h3 className="text-xs font-medium text-muted">Handed over, or not yours</h3>
          <ul className="grid gap-2">{rows(groups.other, "other")}</ul>
        </section>
      )}
      {opener}
      <p className="text-xs text-faint">
        A vault handed to you from another wallet is listed here once you open it by its address, or for a few minutes after the
        handover starts.
      </p>
    </div>
  );
}

function OpenForm({ onOpen }: { onOpen: (vault: Address) => void }) {
  const id = useId();
  const [text, setText] = useState("");
  const [bad, setBad] = useState(false);
  return (
    <form
      className="grid gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        const value = text.trim();
        if (!isAddress(value, { strict: false })) return setBad(true);
        setBad(false);
        setText("");
        onOpen(getAddress(value));
      }}
    >
      <label htmlFor={id} className="text-xs text-muted">
        Open a vault by its address
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          className={INPUT}
          value={text}
          placeholder="0x…"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={bad}
          onChange={(e) => {
            setText(e.target.value);
            setBad(false);
          }}
        />
        <button type="submit" className={BUTTON}>
          Open
        </button>
      </div>
      {bad && (
        <p className="text-xs text-danger-text" role="alert">
          {"That isn't an address."}
        </p>
      )}
    </form>
  );
}

type RowProps = {
  lock: Lock;
  role: Role;
  now: number;
  busy: boolean;
  running: { kind: ActionKind; sent: boolean } | null;
  note: ActionNote | undefined;
  onAct: (action: VaultAction) => void;
  /** The chain's time right now, for a check made on a click. */
  nowAt: () => number;
};

function LockRow({ lock, role, now, busy, running, note, onAct, nowAt }: RowProps) {
  const [panel, setPanel] = useState<"extend" | "transfer" | null>(null);
  const unlocked = isUnlocked(lock, now);
  const empty = isEmpty(lock);
  const mine = role === "owner" && !empty;
  const waiting = (kind: ActionKind) => (running?.kind === kind ? (running.sent ? "Waiting for confirmation…" : "Confirm in your wallet…") : null);
  const title = lockTitle(lock, amountText);
  const pair =
    lock.kind === "position"
      ? `${lock.symbol0}/${lock.symbol1} · ${lockFeeText(lock)}`
      : lock.pair
        ? `Uniswap v2 LP token for ${lock.pair.symbol0}/${lock.pair.symbol1}`
        : null;

  return (
    <li className="grid gap-2 rounded-lg border border-border bg-surface p-3" {...dragSourceProps(lockDragItem(lock))}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="break-all font-medium">{title}</p>
          {pair && <p className="text-xs text-muted">{pair}</p>}
        </div>
        <span
          className={`rounded px-1.5 py-0.5 text-[11px] bg-surface-2 ${empty ? "text-muted" : unlocked ? "text-accent-3-text" : "text-accent-2-text"}`}
        >
          {empty ? "Withdrawn" : unlocked ? "Unlocked" : "Locked"}
        </span>
      </div>
      <p className="text-xs">
        {empty
          ? lock.kind === "position"
            ? "The position was withdrawn from this vault."
            : "Everything in this vault was withdrawn."
          : unlocked
            ? `Unlocked since ${formatWhen(lock.unlockAt)}.`
            : `Unlocks ${formatWhen(lock.unlockAt)} (${untilText(lock.unlockAt, now)}).`}
      </p>
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        <a className={LINK} href={explorerUrl("address", lock.vault)} target="_blank" rel="noopener noreferrer" title={lock.vault}>
          {`Vault ${shortAddress(lock.vault)}`}
        </a>
        {proofTokens(lock).map((token) => (
          <a key={token} className={LINK} href={`/t/${token}`} target="_blank" rel="noopener noreferrer" title={`Proof page for ${token}`}>
            {`Proof: ${proofLabel(lock, token)}`}
          </a>
        ))}
      </p>

      {role === "other" && <p className="text-xs text-muted">{`${NOT_YOURS} Its owner is ${shortAddress(lock.owner)}.`}</p>}

      {role === "incoming" && (
        <div className="grid gap-2">
          <p className="text-xs">{`${shortAddress(lock.owner)} started handing this vault to you. Accept to become its owner.`}</p>
          <button type="button" className={`${BUTTON} w-fit`} disabled={busy} onClick={() => onAct({ kind: "accept" })}>
            {waiting("accept") ?? "Accept ownership"}
          </button>
        </div>
      )}

      {mine && lock.pendingOwner && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span>{`Handing to ${shortAddress(lock.pendingOwner)}: waiting for them to accept.`}</span>
          <button type="button" className={BUTTON} disabled={busy} onClick={() => onAct({ kind: "transfer", to: zeroAddress })}>
            {waiting("transfer") ?? "Cancel the handover"}
          </button>
        </div>
      )}

      {mine && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={BUTTON} disabled={busy} aria-expanded={panel === "extend"} onClick={() => setPanel(panel === "extend" ? null : "extend")}>
            {waiting("extend") ?? "Extend"}
          </button>
          {lock.kind === "position" && (
            <button type="button" className={BUTTON} disabled={busy} onClick={() => onAct({ kind: "collect" })}>
              {waiting("collect") ?? "Collect fees"}
            </button>
          )}
          <button
            type="button"
            className={BUTTON}
            disabled={busy || !unlocked}
            title={unlocked ? undefined : `Withdraw opens ${formatWhen(lock.unlockAt)}`}
            onClick={() => onAct({ kind: "withdraw" })}
          >
            {waiting("withdraw") ?? "Withdraw"}
          </button>
          <button type="button" className={BUTTON} disabled={busy} aria-expanded={panel === "transfer"} onClick={() => setPanel(panel === "transfer" ? null : "transfer")}>
            Transfer
          </button>
        </div>
      )}
      {mine && !unlocked && (
        <p className="text-xs text-faint">
          {lock.kind === "position" ? "Withdraw sends the position to your wallet, from the unlock date." : `Withdraw sends every ${lock.symbol} in the vault to your wallet, from the unlock date.`}
        </p>
      )}

      {mine && panel === "extend" && (
        <ExtendPanel
          lock={lock}
          now={now}
          busy={busy}
          onExtend={(unlockAt) => {
            setPanel(null);
            onAct({ kind: "extend", unlockAt });
          }}
          nowAt={nowAt}
        />
      )}
      {mine && panel === "transfer" && (
        <TransferPanel
          lock={lock}
          busy={busy}
          onTransfer={(to) => {
            setPanel(null);
            onAct({ kind: "transfer", to });
          }}
        />
      )}

      {note && (
        <p className={`text-xs ${note.outcome.result === "done" ? "text-accent-2-text" : "text-danger-text"}`} role={note.outcome.result === "done" ? "status" : "alert"}>
          {noteText(note.kind, note.outcome, lock)}{" "}
          {note.outcome.hash && (
            <a className={LINK} href={explorerUrl("tx", note.outcome.hash)} target="_blank" rel="noopener noreferrer">
              View the transaction
            </a>
          )}{" "}
          <button type="button" className="text-muted underline" onClick={() => vaultSession.dismissNote(lock.vault)}>
            Dismiss
          </button>
        </p>
      )}
    </li>
  );
}

const lockFeeText = (lock: PositionLock): string =>
  lock.feeShareBps === null ? "fee share unknown" : `ArcOS keeps ${bpsText(BigInt(lock.feeShareBps))} of collected fees`;

function proofLabel(lock: Lock, token: Address): string {
  const t = token.toLowerCase();
  if (lock.kind === "position") return t === lock.currency1?.toLowerCase() ? lock.symbol1 : lock.symbol0;
  if (lock.pair) return t === lock.pair.token1.toLowerCase() ? lock.pair.symbol1 : lock.pair.symbol0;
  return lock.symbol;
}

function ExtendPanel({ lock, now, busy, onExtend, nowAt }: { lock: Lock; now: number; busy: boolean; onExtend: (unlockAt: number) => void; nowAt: () => number }) {
  const id = useId();
  const [choice, setChoice] = useState<{ kind: "preset"; days: number } | { kind: "date"; value: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const base = extendBase(lock.unlockAt, now);
  const pick = (at: number) => (choice === null ? null : choice.kind === "preset" ? presetUnlock(extendBase(lock.unlockAt, at), choice.days) : unlockFromDate(choice.value, at));
  const target = pick(now);
  const check = target === null ? null : checkExtend(target, lock.unlockAt, now);
  const bounds = dateBounds(now, lock.unlockAt);
  const full = bounds.min > bounds.max;
  return (
    <div className="grid gap-2 rounded-md border border-border-2 p-2">
      {full ? (
        <p className="text-xs text-muted">This lock already runs as long as the contract allows: 10 years from now.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {PRESET_DAYS.map((days) => {
              const at = presetUnlock(base, days);
              const fits = checkExtend(at, lock.unlockAt, now).ok;
              return (
                <button
                  key={days}
                  type="button"
                  className={`${BUTTON} ${choice?.kind === "preset" && choice.days === days ? PICKED : ""}`}
                  aria-pressed={choice?.kind === "preset" && choice.days === days}
                  disabled={!fits}
                  onClick={() => {
                    setChoice({ kind: "preset", days });
                    setError(null);
                  }}
                >
                  {`+${days === 365 ? "1 year" : `${days} days`}`}
                </button>
              );
            })}
            <label className="sr-only" htmlFor={id}>
              Or pick a new date
            </label>
            <input
              id={id}
              type="date"
              className="min-h-8 rounded-md border border-border-2 bg-surface px-2 text-xs pointer-coarse:min-h-11"
              min={bounds.min}
              max={bounds.max}
              value={choice?.kind === "date" ? choice.value : ""}
              onChange={(e) => {
                setChoice(e.target.value ? { kind: "date", value: e.target.value } : null);
                setError(null);
              }}
            />
          </div>
          {check && (check.ok ? <p className="text-xs">{`New unlock date: ${formatWhen(check.unlockAt)}.`}</p> : <p className="text-xs text-danger-text">{check.error}</p>)}
          <p className="text-xs text-faint">A lock can only get longer. The new date must be later than the current one, and at most 10 years from now.</p>
          {error && (
            <p className="text-xs text-danger-text" role="alert">
              {error}
            </p>
          )}
          <button
            type="button"
            className={`${BUTTON} w-fit`}
            disabled={busy || !check?.ok}
            onClick={() => {
              const at = nowAt();
              const fresh = pick(at);
              const result = checkExtend(fresh, lock.unlockAt, at);
              if (!result.ok) return setError(result.error);
              onExtend(result.unlockAt);
            }}
          >
            Extend the lock
          </button>
        </>
      )}
    </div>
  );
}

function TransferPanel({ lock, busy, onTransfer }: { lock: Lock; busy: boolean; onTransfer: (to: Address) => void }) {
  const id = useId();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="grid gap-2 rounded-md border border-border-2 p-2"
      onSubmit={(e) => {
        e.preventDefault();
        const issue = transferIssue(text, lock);
        if (issue) return setError(issue);
        onTransfer(getAddress(text.trim()));
      }}
    >
      <label htmlFor={id} className="text-xs text-muted">
        New owner
      </label>
      <input
        id={id}
        className={INPUT}
        value={text}
        placeholder="0x…"
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
      />
      <p className="text-xs text-faint">{TRANSFER_NOTE}</p>
      <p className="break-all font-mono text-[11px] text-muted">{lock.vault}</p>
      {error && (
        <p className="text-xs text-danger-text" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className={`${BUTTON} w-fit`} disabled={busy}>
        Start the handover
      </button>
    </form>
  );
}
