import { ArrowLeftRight } from "lucide-react";
import type { AppManifest } from "@arcos/shell";

export const swap: AppManifest = {
  id: "swap",
  name: "Swap",
  blurb: "USDC, EURC and cirBTC",
  icon: ArrowLeftRight,
  category: "trade",
  window: { w: 420, h: 480 },
  load: () => import("./Window"),
  requiresWallet: true,
  release: "r0",
  pinned: true,
};
