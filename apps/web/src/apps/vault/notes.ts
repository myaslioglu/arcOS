import { isAddress, zeroAddress } from "viem";
import { displayUnits } from "@/lib/display-amount";
import { shortAddress } from "@/lib/format";
import type { ActionOutcome, Collected } from "./flow";
import { formatWhen } from "./lockForm";
import type { Lock, PositionLock } from "./locks";
import type { ActionKind } from "./session";

/** What Your locks says after an action, and what it checks before one. Pure. */

/** What a finished action says on its row. */
export function noteText(kind: ActionKind, outcome: ActionOutcome, lock: Lock | undefined): string {
  if (outcome.result !== "done") return outcome.message;
  switch (kind) {
    case "extend":
      return lock ? `Extended. It now unlocks ${formatWhen(lock.unlockAt)}.` : "Extended.";
    case "collect":
      return collectedText(outcome.collected, lock?.kind === "position" ? lock : null);
    case "withdraw":
      return lock?.kind === "position" ? "Withdrawn. The position is back in your wallet." : "Withdrawn to your wallet.";
    case "transfer":
      return "Done. The new owner can now accept it in Vault.";
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
