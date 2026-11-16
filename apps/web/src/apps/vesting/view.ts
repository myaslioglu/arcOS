import { formatUnits } from "viem";
import { displayAmount } from "@/lib/display-amount";
import { utcText } from "./span";
import type { TokenInfo, WalletView } from "./load";

/** How a wallet reads at `now`: before its cliff, vesting, or fully vested. */
export type Phase = "locked" | "vesting" | "done";

export function phaseOf(w: Pick<WalletView, "start" | "duration" | "cliff">, now: bigint): Phase {
  if (now >= w.start + w.duration) return "done";
  if (now < w.start + w.cliff) return "locked";
  return "vesting";
}

/** The one line under a wallet's title: when its tokens start to unlock, that they are unlocking, or that they all have. */
export function phaseText(w: Pick<WalletView, "start" | "duration" | "cliff">, now: bigint): string {
  switch (phaseOf(w, now)) {
    case "locked":
      return `Nothing unlocks until ${utcText(w.start + w.cliff)}.`;
    case "vesting":
      return `Unlocking until ${utcText(w.start + w.duration)}.`;
    case "done":
      return `Fully unlocked since ${utcText(w.start + w.duration)}.`;
  }
}

/** An amount of the wallet's token for display, rounded down: what a beneficiary is shown is never overstated. */
export function amountText(units: bigint | null, info: TokenInfo | null): string {
  if (units === null || info === null) return "?";
  return `${displayAmount(formatUnits(units, info.decimals), { mode: "down" })} ${info.symbol}`;
}

export type ReleaseState = { enabled: boolean; label: string; reason: string | null };

/** Whether the Release button can be pressed, and what it says. The wallet's own `releasable(token)` decides. */
export function releaseState(w: Pick<WalletView, "tokenInfo" | "releasable">, busy: boolean): ReleaseState {
  if (busy) return { enabled: false, label: "Releasing…", reason: null };
  if (w.tokenInfo === null) return { enabled: false, label: "Release", reason: "Couldn't read this schedule's token. Try again." };
  if (w.releasable === null) return { enabled: false, label: "Release", reason: "Couldn't read what can be released. Try again." };
  if (w.releasable === 0n) return { enabled: false, label: "Release", reason: "Nothing can be released yet." };
  return { enabled: true, label: `Release ${amountText(w.releasable, w.tokenInfo)}`, reason: null };
}

/** The "now" marker's place on the curve, 0 to 1, or null before the schedule starts. */
export function nowFraction(start: bigint, duration: bigint, now: bigint): number | null {
  if (now < start || duration <= 0n) return null;
  if (now >= start + duration) return 1;
  return Number(((now - start) * 10_000n) / duration) / 10_000;
}
