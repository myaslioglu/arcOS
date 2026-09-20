import { Hourglass, Lock, Radar, ShieldCheck, SquareTerminal, Trash2 } from "lucide-react";
import type { AppManifest } from "@arcos/shell";

const soon = (m: Pick<AppManifest, "id" | "name" | "blurb" | "icon" | "category" | "release">): AppManifest => ({
  ...m,
  window: { w: 480, h: 420 },
  load: async () => ({ default: () => null }),
  requiresWallet: false,
  comingSoon: true,
});

export const SOON: AppManifest[] = [
  soon({ id: "vault", name: "Vault", blurb: "Lock liquidity and team tokens", icon: Lock, category: "trust", release: "r2" }),
  soon({ id: "vesting", name: "Vesting", blurb: "Release tokens on a schedule", icon: Hourglass, category: "trust", release: "r2" }),
  soon({ id: "watchdog", name: "Watchdog", blurb: "Alerts when a token you hold changes", icon: ShieldCheck, category: "trust", release: "r1" }),
  soon({ id: "radar", name: "Radar", blurb: "New tokens and locks, scored", icon: Radar, category: "trade", release: "r1" }),
  soon({ id: "revoke", name: "Revoke", blurb: "Remove token approvals", icon: Trash2, category: "system", release: "r1" }),
  soon({ id: "terminal", name: "Terminal", blurb: "Do all of this by typing", icon: SquareTerminal, category: "system", release: "phase2" }),
];
