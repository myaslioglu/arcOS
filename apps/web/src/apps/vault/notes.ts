import { isAddress, zeroAddress } from "viem";
import { displayUnits, displayWei } from "@/lib/display-amount";
import { shortAddress } from "@/lib/format";
import type { ActionOutcome, Collected, LockOutcome, VaultAction } from "./flow";
import { formatWhen } from "./lockForm";
import type { Lock, PositionLock } from "./locks";
import type { LockRunStep, LockSummary } from "./session";

/** What Vault says while a lock runs and once it is done, and what Your locks says after an action. Pure. */

/** What a running lock is waiting for, step by step. */
export function lockStepText(summary: LockSummary, step: LockRunStep, sent: boolean): string {
  switch (step) {
    case "check":
      return "Checking the fee and the approval…";
    case "approve":
      if (sent) return "Waiting for the approval to confirm…";
      return summary.kind === "token"
        ? `Approve exactly ${summary.approval} for the vault factory in your wallet…`
        : `Approve ${summary.approval} for the vault factory in your wallet…`;
    case "lock":
      return sent ? "Waiting for the lock to confirm…" : `Confirm the lock in your wallet. It sends the ${displayWei(summary.fee, "up")} USDC fee.`;
    case "find":
      return "Your wallet answered with an error. Looking for the lock on chain, for up to a minute…";
  }
}

/**
 * What a finished lock holds: for a token, what reached the vault as the factory's event reports it (less an LP
 * token's share, or a token's own cut on transfer), rounded down; for a position, the position.
 */
export function lockedText(summary: LockSummary, outcome: Extract<LockOutcome, { result: "locked" }>): string {
  const what = summary.token && outcome.amount !== undefined ? `${displayUnits(outcome.amount, summary.token.decimals, "down")} ${summary.token.symbol}` : summary.label;
  return `${what} is in its vault until ${formatWhen(summary.unlockAt)}.`;
}

/**
 * What a finished action says on its row. An extend's new date is the one it was sent with, which the vault's event
 * confirmed (flow.ts's actionHappened): the list may still show the old one until it is read again.
 */
export function noteText(action: VaultAction, outcome: ActionOutcome, lock: Lock | undefined): string {
  if (outcome.result !== "done") return outcome.message;
  switch (action.kind) {
    case "extend":
      return `Extended. It now unlocks ${formatWhen(action.unlockAt)}.`;
    case "collect":
      return collectedText(outcome.collected, lock?.kind === "position" ? lock : null);
    case "withdraw":
      return lock?.kind === "position" ? "Withdrawn. The position is back in your wallet." : "Withdrawn to your wallet.";
    case "transfer":
      return `Done. ${shortAddress(action.to)} can now accept it in Vault.`;
    case "cancel":
      return "Handover cancelled. The vault stays yours.";
    case "accept":
      return "You now own this vault.";
  }
}

/** "Collected 12.5 VTA and 3.1 VTB. ArcOS kept 0.25 VTA and 0.06 VTB." from a collect's events. */
export function collectedText(collected: readonly Collected[], lock: PositionLock | null): string {
  const paid = collected.filter((c) => c.toOwner > 0n || c.toPlatform > 0n);
  if (paid.length === 0) return "There were no fees to collect.";
  const label = (c: Collected, units: bigint) => {
    const which = lock && c.currency.toLowerCase() === lock.currency1?.toLowerCase() ? 1 : 0;
    const decimals = which === 1 ? lock?.decimals1 : lock?.decimals0;
    const symbol = lock ? (which === 1 ? lock.symbol1 : lock.symbol0) : shortAddress(c.currency);
    return decimals === null || decimals === undefined ? `${units} units of ${symbol}` : `${displayUnits(units, decimals, "down")} ${symbol}`;
  };
  const join = (parts: string[]) => parts.join(" and ");
  const kept = paid.filter((c) => c.toPlatform > 0n);
  const toYou = `Collected ${join(paid.map((c) => label(c, c.toOwner)))}.`;
  return kept.length ? `${toYou} ArcOS kept ${join(kept.map((c) => label(c, c.toPlatform)))}.` : toYou;
}

/** Why `text` can't be the new owner, or null when it can. */
export function transferIssue(text: string, lock: Pick<Lock, "owner" | "vault">): string | null {
  const value = text.trim();
  if (!isAddress(value, { strict: false })) return "Enter the new owner's address.";
  const to = value.toLowerCase();
  if (to === zeroAddress) return "The new owner can't be the zero address.";
  if (to === lock.owner.toLowerCase()) return "That's already the owner.";
  if (to === lock.vault.toLowerCase()) return "That's the vault itself.";
  return null;
}
