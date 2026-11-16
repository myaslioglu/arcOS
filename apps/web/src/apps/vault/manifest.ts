import { Lock } from "lucide-react";
import type { AppManifest } from "@arcos/shell";

/**
 * Vault: locks a token, a Uniswap v2 LP token or a Uniswap v3/v4 position until a date, each in a vault contract of its
 * own. Live only where @arcos/chain's ARCOS names a VaultFactory (registry.ts's NEEDS_CONTRACT); elsewhere its grey
 * stand-in in soon.ts shows. A singleton: a dropped token, position or lock, or the params it opens with, fill its
 * forms (the window follows each new params object, as the shell replaces them on an open window).
 */
export const vault: AppManifest = {
  id: "vault",
  name: "Vault",
  blurb: "Lock liquidity and team tokens",
  icon: Lock,
  category: "trust",
  window: { w: 560, h: 640 },
  load: () => import("./Window"),
  acceptsDrop: ["token", "lp-position", "lock"],
  requiresWallet: true,
  release: "r2",
};
