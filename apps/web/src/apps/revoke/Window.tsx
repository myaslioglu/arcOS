"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { useConnection, usePublicClient, useWriteContract } from "wagmi";
import { getAddress, isAddress, type Address } from "viem";
import { activeChain, activeNetwork, explorerUrl } from "@arcos/chain";
import { dragSourceProps, useDesktop, useDropTarget, type AppProps } from "@arcos/shell";
import { ConnectGate } from "@/components/ConnectGate";
import { spenderLabel, type Approval } from "@/lib/approvals";
import { shortAddress } from "@/lib/format";
import { revokeStep, type RevokeClient, type RowOutcome } from "./flow";
import {
  approvalText,
  dragItemOf,
  fetchApprovals,
  focusAfterRun,
  focusWasLost,
  inspectButtonLabel,
  revokeButtonLabel,
  revokeView,
  rowForDrop,
  rowKey,
  stillLive,
  type FocusTarget,
} from "./rows";
import { revokeSession } from "./session";
import { revokeSteps } from "./tx";

/** Every control is at least 32px high, 44px on touch. */
const BUTTON = "min-h-8 rounded-md border border-border-2 px-3 text-xs pointer-coarse:min-h-11 disabled:opacity-50";

/** Under every state: what Revoke lists, and what revoking costs. */
const NOTE = "Lists token allowances, NFT approvals and Permit2 allowances. Each revoke is a transaction your wallet confirms.";

const KIND_LABEL: Record<Approval["kind"], string> = {
  erc20: "Token",
  erc721: "NFT",
  operator: "All items",
  permit2: "Permit2",
};

/** A Permit2 allowance's expiry, as a UTC date. */
const expiryText = (seconds: number) => `Expires ${new Date(seconds * 1000).toISOString().slice(0, 10)}`;

/**
 * Revoke: the live approvals of the connected wallet, or of any address pasted in (read-only): ERC-20 allowances,
 * single NFTs' approvals, operators over whole collections, and Permit2 allowances. Its own wallet can revoke each
 * (see tx.ts for the transaction each kind takes), or all of them one transaction at a time, every Permit2 pair in one
 * `lockdown`; the wallet confirms each. The window's `owner` param names the address to show, as the Terminal's
 * `approvals` command and the form below set it.
 */
export default function RevokeWindow({ params }: AppProps) {
  const { address } = useConnection();
  const { open } = useDesktop();
  const view = revokeView(params.owner, address);
  return (
    <div className="grid gap-4 p-5 text-sm">
      <LookupForm mine={address} onLook={(owner) => open("revoke", { owner })} />
      {view.kind === "ask" && (
        <div className="grid justify-items-start gap-2">
          <p className="text-muted">Connect a wallet, or paste an address to look.</p>
          <button type="button" className={BUTTON} onClick={() => open("wallet")}>
            Open Wallet
          </button>
        </div>
      )}
      {view.kind === "invalid" && (
        <p className="text-danger-text" role="alert">
          {"That isn't an address."}
        </p>
      )}
      {view.kind === "list" &&
        (view.canRevoke ? (
          <ConnectGate>
            <ApprovalList key={view.owner} owner={view.owner} canRevoke />
          </ConnectGate>
        ) : (
          <ApprovalList key={view.owner} owner={view.owner} canRevoke={false} />
        ))}
      <p className="text-xs text-faint">{NOTE}</p>
    </div>
  );
}

function LookupForm({ mine, onLook }: { mine?: string; onLook: (owner: Address) => void }) {
  const id = useId();
  const [text, setText] = useState("");
  const [bad, setBad] = useState(false);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const value = text.trim();
    if (!isAddress(value, { strict: false })) {
      setBad(true);
      return;
    }
    setBad(false);
    onLook(getAddress(value));
  };
  return (
    <form onSubmit={submit} className="grid gap-2">
      <label htmlFor={id} className="text-xs text-muted">
        Address to look up
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id={id}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setBad(false);
          }}
          placeholder="0x…"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={bad}
          className="min-h-8 min-w-0 flex-1 rounded-md border border-border-2 bg-surface px-2 font-mono text-xs pointer-coarse:min-h-11 pointer-coarse:text-base"
        />
        <button type="submit" className={BUTTON}>
          Look
        </button>
        {mine && isAddress(mine, { strict: false }) && (
          <button
            type="button"
            className={BUTTON}
            onClick={() => {
              setText("");
              setBad(false);
              onLook(getAddress(mine));
            }}
          >
            My wallet
          </button>
        )}
      </div>
      {bad && (
        <p className="text-xs text-danger-text" role="alert">
          {"That isn't an address."}
        </p>
      )}
    </form>
  );
}

function ApprovalList({ owner, canRevoke }: { owner: Address; canRevoke: boolean }) {
  const chain = activeChain();
  const network = activeNetwork();
  const { address, chainId: walletChainId } = useConnection();
  const client = usePublicClient({ chainId: chain.id });
  const writeContract = useWriteContract();
  const { open } = useDesktop();
  const query = useQuery({
    queryKey: ["approvals", owner.toLowerCase()],
    queryFn: () => fetchApprovals(owner),
    retry: false,
  });
  // The revoke run lives outside this component (see ./session), so it survives the window closing mid-revoke: a
  // reopened window shows the transaction still waiting on the wallet, then its failure, or the row no longer listed.
  const session = useSyncExternalStore(revokeSession.subscribe, revokeSession.getSnapshot, revokeSession.getSnapshot);
  const { failures, left } = revokeSession.ownerState(session, owner);
  const run = session.run;
  // One run at a time, page-wide: every Revoke control is disabled while any is under way.
  const busy = run !== null;
  const mine = run?.owner === owner.toLowerCase() ? run : null;
  // Focus targets after a row disappears: the list's own landmark (no heading text exists here, so this container
  // stands in for one — see focusTargetAfterRemoval's "heading" case) and each row's Revoke button.
  const listRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  // Where focus goes once a run has ended. revoke() only stores it: every Revoke button is disabled while busy, and a
  // disabled button can't take focus, so the effect acts once busy is false again, after the list has re-rendered
  // without a removed row. It moves focus only if it was lost, which is to say the body holds it, as it does when the
  // focused row leaves the list or its button is disabled. A visitor who has moved on meanwhile, to the Terminal or
  // another window, keeps their place. The list's container stands in for a row no longer listed.
  const pendingFocus = useRef<FocusTarget | null>(null);
  useEffect(() => {
    if (busy) return;
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    if (!focusWasLost(document.activeElement, document.body)) return;
    const row = target.kind === "row" ? rowRefs.current[target.key] : null;
    (row ?? listRef.current)?.focus();
  }, [busy]);

  const rowsNow = query.data ? stillLive(owner, query.data.approvals) : [];
  const { over, props: trashProps } = useDropTarget(canRevoke ? ["approval"] : undefined, (item) => {
    // A drop names a row; only a row this list shows is revoked (see rowForDrop).
    const row = rowForDrop(rowsNow, item);
    if (row) revoke([row]);
  });

  if (query.isPending)
    return (
      <p className="text-muted" aria-live="polite">
        Loading approvals…
      </p>
    );
  // A failed refetch that still has an earlier answer (query.isRefetchError) keeps showing the list,
  // with a small notice below, instead of hiding it behind this full error state — which is shown
  // only when there is no data at all (isLoadingError: the query has never once succeeded).
  if (query.isLoadingError) {
    return (
      <div className="grid justify-items-start gap-2">
        <p className="text-danger-text" role="alert">
          {"Couldn't load approvals. Try again in a minute."}
        </p>
        <button type="button" className={BUTTON} onClick={() => void query.refetch()}>
          Try again
        </button>
      </div>
    );
  }

  // key={owner} on this component (see RevokeWindow) means every state hook above starts fresh for a new owner;
  // the session store keeps failures per owner, and stillLive carries the owner in its own key.
  const rows = rowsNow;

  // Revokes `targets`, one transaction at a time (see ./flow and ./session). The window only starts the run and says
  // where focus goes when it ends; everything else is reported into the session store.
  function revoke(targets: Approval[]) {
    // Only the owner's own wallet revokes: a wallet switched since this list was drawn starts nothing.
    if (busy || !client || !address || address.toLowerCase() !== owner.toLowerCase()) return;
    const keysBefore = rowsNow.map(rowKey);
    // A target an earlier run left behind (one that ended before busy ever changed) mustn't steer this one.
    pendingFocus.current = null;
    const deps = {
      client: client as unknown as RevokeClient,
      owner,
      account: address,
      chainId: chain.id,
      walletChainId,
      writeContractAsync: writeContract.mutateAsync as (request: never) => Promise<`0x${string}`>,
    };
    void revokeSession.run(
      owner,
      revokeSteps(targets),
      (step, onSent) => revokeStep(step, { ...deps, onSent }),
      (outcomes: RowOutcome[]) => {
        pendingFocus.current = focusAfterRun(keysBefore, outcomes);
      },
    );
  }

  const progress =
    mine && mine.steps > 1
      ? `Revoking ${mine.step} of ${mine.steps}…${mine.stopping ? " Stopping after this one." : ""}`
      : null;

  return (
    <div ref={listRef} tabIndex={-1} role="region" aria-label="Approvals list" className="grid gap-3">
      {!canRevoke && <p className="text-xs text-muted">{`Viewing ${shortAddress(owner)}. Only its own wallet can revoke.`}</p>}
      {query.isRefetchError && (
        <p className="text-xs text-muted" role="status">
          {"Couldn't refresh approvals. Showing the last list."}
        </p>
      )}
      {query.data.truncated && (
        <p className="text-xs text-accent-3-text" role="alert">
          {"This list may be incomplete: some approvals couldn't be read."}
        </p>
      )}
      {/* Stop goes with the run, not with the list: a refetch can shrink the list to one row, or none, mid-run. */}
      {((canRevoke && rows.length > 1) || (mine && mine.steps > 1)) && (
        <div className="flex flex-wrap items-center gap-2">
          {canRevoke && rows.length > 1 && (
            <button type="button" className={BUTTON} disabled={busy} onClick={() => revoke(rows)}>
              {`Revoke all (${rows.length})`}
            </button>
          )}
          {mine && mine.steps > 1 && (
            <button type="button" className={BUTTON} disabled={mine.stopping} onClick={revokeSession.stop}>
              Stop after this one
            </button>
          )}
        </div>
      )}
      {progress && (
        <div className="grid gap-1" role="status">
          <p>{progress}</p>
          <p className="text-xs text-muted">Keep this tab open until it finishes. You can close this window; the revokes continue.</p>
        </div>
      )}
      {canRevoke && rows.length > 0 && (
        <div
          {...trashProps}
          className={`rounded-lg border border-dashed border-border-2 p-3 text-center text-xs text-muted ${over ? "outline outline-2 outline-accent" : ""}`}
        >
          Drop an approval here to revoke it.
        </div>
      )}
      {rows.length === 0 ? (
        !query.data.truncated && <p className="text-muted">No active approvals.</p>
      ) : (
        <ul className="grid gap-2">
          {rows.map((row) => {
            const key = rowKey(row);
            const failure = failures[key];
            const spenderName = spenderLabel(row.spender, network);
            const waiting = mine?.current.includes(key) ?? false;
            const leftNow = left[key];
            return (
              <li
                key={key}
                className="grid gap-2 rounded-lg border border-border bg-surface p-3"
                {...(canRevoke ? dragSourceProps(dragItemOf(row)) : {})}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="break-all font-mono text-sm" title={row.token}>
                      {row.symbol ? `${row.symbol} · ${shortAddress(row.token)}` : shortAddress(row.token)}
                    </p>
                    <p className="truncate text-xs text-muted">
                      {`${KIND_LABEL[row.kind]} · ${row.name ?? "Unnamed token"}`}
                    </p>
                  </div>
                  <div className="min-w-0 text-right">
                    <p className="min-w-0 break-all font-mono text-sm">
                      {approvalText(leftNow !== undefined ? { ...row, allowance: leftNow } : row)}
                    </p>
                    {row.expiration !== undefined && <p className="text-xs text-muted">{expiryText(row.expiration)}</p>}
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-muted">
                    {"Spender: "}
                    {spenderName ?? "Unknown contract"}{" "}
                    <span className="font-mono" title={row.spender}>
                      {shortAddress(row.spender)}
                    </span>
                    {!spenderName && (
                      <>
                        {" "}
                        <button
                          type="button"
                          className="min-h-8 text-accent-text underline pointer-coarse:min-h-11"
                          aria-label={inspectButtonLabel(row.spender)}
                          onClick={() => open("inspector", { token: row.spender })}
                        >
                          Inspect
                        </button>
                      </>
                    )}
                  </p>
                  {canRevoke && (
                    <button
                      type="button"
                      className={BUTTON}
                      disabled={busy}
                      aria-label={revokeButtonLabel(row, spenderName)}
                      ref={(el) => {
                        rowRefs.current[key] = el;
                      }}
                      onClick={() => revoke([row])}
                    >
                      {waiting ? (mine?.sent ? "Waiting for confirmation…" : "Waiting for your wallet…") : "Revoke"}
                    </button>
                  )}
                </div>
                {failure && (
                  <p className="text-xs text-danger-text" role="alert">
                    {failure.text}
                    {failure.hash && (
                      <>
                        {" "}
                        <a
                          className="inline-flex min-h-8 items-center text-accent-text underline pointer-coarse:min-h-11"
                          href={explorerUrl("tx", failure.hash)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          View on the explorer
                        </a>
                      </>
                    )}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
