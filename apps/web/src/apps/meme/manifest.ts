import { Laugh } from "lucide-react";
import type { AppManifest } from "@arcos/shell";

export const meme: AppManifest = {
  id: "meme",
  name: "Meme",
  blurb: "Soon",
  icon: Laugh,
  category: "trade",
  window: { w: 380, h: 300 },
  load: () => import("./Window"),
  requiresWallet: false,
  release: "r0",
  tag: "Soon",
};
