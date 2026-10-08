import { Radar } from "lucide-react";
import type { AppManifest } from "@arcos/shell";

export const radar: AppManifest = {
  id: "radar",
  name: "Radar",
  blurb: "New tokens, each with Inspector's checks",
  icon: Radar,
  category: "trade",
  window: { w: 560, h: 620 },
  load: () => import("./Window"),
  requiresWallet: false,
  release: "r1",
};
