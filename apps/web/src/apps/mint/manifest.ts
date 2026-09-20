import { Coins } from "lucide-react";
import type { AppManifest } from "@arcos/shell";

export const mint: AppManifest = {
  id: "mint",
  name: "Mint",
  blurb: "Create a token, no code",
  icon: Coins,
  category: "create",
  window: { w: 460, h: 620 },
  load: () => import("./Window"),
  requiresWallet: true,
  release: "r0",
  pinned: true,
};
