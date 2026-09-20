import { Wallet } from "lucide-react";
import type { AppManifest } from "@arcos/shell";

export const wallet: AppManifest = {
  id: "wallet",
  name: "Wallet",
  blurb: "Connect, switch network, disconnect",
  icon: Wallet,
  category: "system",
  window: { w: 420, h: 440 },
  load: () => import("./Window"),
  requiresWallet: false,
  release: "r0",
  pinned: true,
};
