"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { erc20Abi, getAddress, isAddress, type Address } from "viem";
import { activeChain, activeNetwork, explorerUrl } from "@arcos/chain";
import { useDesktop, type AppProps } from "@arcos/shell";
import { ConnectGate } from "@/components/ConnectGate";
import { trackEvent } from "@/lib/analytics";
import { spenderLabel, type Approval } from "@/lib/approvals";
import { UserFacingError } from "@/lib/contract-error";
import { shortAddress } from "@/lib/format";
import { assertWalletOnChain, withChain } from "@/lib/paid-write";
import {
  allowanceText,
  ALLOWANCE_STILL_SET,
  APPROVE_ABI,
  fetchApprovals,
  focusTargetAfterRemoval,
  focusWasLost,
  inspectButtonLabel,
  markRevoked,
  nodeHasSeenApproval,
  revokeButtonLabel,
  revokeFailure,
  revokeView,
  rowKey,
  stillLive,
  type FocusTarget,
  type RevokeStage,
} from "./rows";

/** Every control is at least 32px high, 44px on touch. */
const BUTTON = "min-h-8 rounded-md border border-border-2 px-3 text-xs pointer-coarse:min-h-11 disabled:opacity-50";

/**
 * Revoke: the live ERC-20 approvals of the connected wallet, or of any address pasted in (read-only), each revocable
 * by its own wallet with `approve(spender, 0)`, which the wallet confirms. The window's `owner` param names the address
 * to show, as the Terminal's `approvals` command and the form below set it.
 */
export default function RevokeWindow({ params }: AppProps) {
  const { address } = useAccount();
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
      <p className="text-xs text-faint">Token approvals only. NFT and Permit2 approvals come later.</p>
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
  const { address, chainId: walletChainId } = useAccount();
  const client = usePublicClient({ chainId: chain.id });
  const { writeContractAsync } = useWriteContract();
  const { open } = useDesktop();
  const query = useQuery({
    queryKey: ["approvals", owner.toLowerCase()],
    queryFn: () => fetchApprovals(owner),
    retry: false,
  });
  const [left, setLeft] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [failures, setFailures] = useState<Readonly<Record<string, { text: string; hash?: string }>>>({});
  // Focus targets after a row disappears: the list's own landmark (no heading text exists here, so this container
  // stands in for one — see focusTargetAfterRemoval's "heading" case) and each row's Revoke button.
  const listRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  // Where focus goes once a revoke has ended. revoke() only stores it: every Revoke button is disabled while busy is
  // set, and a disabled button can't take focus, so the effect acts once busy is null again, after the list has
  // re-rendered without a removed row. It moves focus only if it was lost, which is to say the body holds it, as it
  // does when the focused row leaves the list or its button is disabled. A visitor who has moved on meanwhile, to the
  // Terminal or another window, keeps their place. The list's container stands in for a row no longer listed.
  const pendingFocus = useRef<FocusTarget | null>(null);
  useEffect(() => {
    if (busy !== null) return;
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    if (!focusWasLost(document.activeElement, document.body)) return;
    const row = target.kind === "row" ? rowRefs.current[target.key] : null;
    (row ?? listRef.current)?.focus();
  }, [busy]);

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

  // key={owner} on this component (see RevokeWindow) means every state hook above starts fresh for a new owner —
  // there is no per-owner overlay to filter here beyond stillLive, which already carries the owner in its own key.
  const rows = stillLive(owner, query.data.approvals);

  // One revoke at a time: a live allowance check first (below), then approve(spender, 0), simulated,
  // confirmed in the wallet, then the pair is read again at the block the revoke landed in.
  const revoke = async (row: Approval) => {
    const key = rowKey(row);
    if (busy !== null || !client || !address) return;
    const keysBefore = rows.map(rowKey);
    // A revoke that threw before its first await left its target behind: setBusy(key) and setBusy(null) batched into no
    // change, so the effect above never ran to forget it. It mustn't steer this revoke's focus.
    pendingFocus.current = null;
    setBusy(key);
    setFailures((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    let stage: RevokeStage = "signing";
    let hash: `0x${string}` | undefined;
    try {
      // Defence in depth; the real guard is the chainId withChain sets, which viem enforces when signing.
      assertWalletOnChain(walletChainId, chain.id);
      // The server's approvals list is cached for 60 s (approvals-server.ts), so a window reopened in that
      // time can still list a pair whose allowance is already 0 — revoked already, in another tab, or by a
      // wallet that batched it. Read it live, the same read used after the receipt below, before ever
      // asking the wallet to sign: simulating and sending approve(spender, 0) against an already-zero
      // allowance would still succeed (a costly no-op) and prompt the wallet for nothing.
      // The head comes first, live, and the allowance is read at it. A node that is behind the pair's newest approval
      // (a lagging backend behind the RPC gateway) hasn't seen it yet and can answer 0 for an allowance that is still
      // set, so a zero counts as "already revoked" only from a node at or past that block. From one that is behind,
      // the revoke goes on to the simulate: a costly no-op at worst, never a live approval hidden as revoked.
      const head = await client.getBlockNumber({ cacheTime: 0 });
      const liveAllowance = await client.readContract({
        address: row.token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [owner, row.spender],
        blockNumber: head,
      });
      if (liveAllowance === 0n && nodeHasSeenApproval(head, row.lastApprovalBlock)) {
        markRevoked(owner, row, row.lastApprovalBlock);
        pendingFocus.current = focusTargetAfterRemoval(keysBefore, key);
        return;
      }
      // APPROVE_ABI (not erc20Abi) declares no return value: a USDT-style token whose approve sends back no data
      // would otherwise fail simulateContract's decode before the transaction is ever sent.
      const { request } = await client.simulateContract({
        account: address,
        address: row.token,
        abi: APPROVE_ABI,
        functionName: "approve",
        args: [row.spender, 0n],
      });
      hash = await writeContractAsync(withChain(request, chain.id));
      stage = "sent";
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status === "reverted") throw new UserFacingError("The revoke reverted. The approval is unchanged.");
      stage = "confirmed";
      const now = await client.readContract({
        address: row.token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [owner, row.spender],
        blockNumber: receipt.blockNumber,
      });
      if (now === 0n) {
        markRevoked(owner, row, Number(receipt.blockNumber));
        trackEvent("revoke_success");
        pendingFocus.current = focusTargetAfterRemoval(keysBefore, key);
      } else {
        setLeft((prev) => ({ ...prev, [key]: now.toString() }));
        setFailures((prev) => ({ ...prev, [key]: { text: ALLOWANCE_STILL_SET, ...(hash ? { hash } : {}) } }));
      }
    } catch (err) {
      setFailures((prev) => ({ ...prev, [key]: { text: revokeFailure(stage, err), ...(hash ? { hash } : {}) } }));
    } finally {
      // Unless a success stored where focus goes next, it goes back to this row's button: a revoke that ended without
      // removing the row (a failure) left focus on the body, where the disabled button dropped it.
      if (pendingFocus.current === null) pendingFocus.current = { kind: "row", key };
      setBusy(null);
    }
  };

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
      {rows.length === 0 ? (
        !query.data.truncated && <p className="text-muted">No active token approvals.</p>
      ) : (
        <ul className="grid gap-2">
          {rows.map((row) => {
            const key = rowKey(row);
            const failure = failures[key];
            const spenderName = spenderLabel(row.spender, network);
            return (
              <li key={key} className="grid gap-2 rounded-lg border border-border bg-surface p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="break-all font-mono text-sm" title={row.token}>
                      {row.symbol ? `${row.symbol} · ${shortAddress(row.token)}` : shortAddress(row.token)}
                    </p>
                    <p className="truncate text-xs text-muted">{row.name ?? "Unnamed token"}</p>
                  </div>
                  <p className="min-w-0 break-all font-mono text-sm">{allowanceText(left[key] ?? row.allowance, row.decimals)}</p>
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
                      disabled={busy !== null}
                      aria-label={revokeButtonLabel(row, spenderName)}
                      ref={(el) => {
                        rowRefs.current[key] = el;
                      }}
                      onClick={() => void revoke(row)}
                    >
                      {busy === key ? "Waiting for your wallet…" : "Revoke"}
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
