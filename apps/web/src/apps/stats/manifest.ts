import { ChartColumn } from "lucide-react";
import type { AppManifest } from "@arcos/shell";

export const stats: AppManifest = {
  id: "stats",
  name: "Stats",
  blurb: "How much ArcOS is used",
  icon: ChartColumn,
  category: "system",
  window: { w: 440, h: 520 },
  load: () => import("./Window"),
  requiresWallet: false,
  release: "r1",
};
