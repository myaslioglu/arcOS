import { Hourglass } from "lucide-react";
import type { AppManifest } from "@arcos/shell";

/**
 * Listed live only where `ARCOS[network].vestingFactory` is set (`NEEDS_CONTRACT` in ../registry.ts); elsewhere the grey
 * stand-in in ../soon.ts shows instead.
 */
export const vesting: AppManifest = {
  id: "vesting",
  name: "Vesting",
  blurb: "Release tokens on a schedule",
  icon: Hourglass,
  category: "trust",
  window: { w: 560, h: 680 },
  load: () => import("./Window"),
  acceptsDrop: ["token"],
  requiresWallet: true,
  release: "r2",
};
