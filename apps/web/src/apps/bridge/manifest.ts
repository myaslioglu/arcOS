import { Waypoints } from "lucide-react";
import type { AppManifest } from "@arcos/shell";

export const bridge: AppManifest = {
  id: "bridge",
  name: "Bridge",
  blurb: "Move USDC to and from Arc",
  icon: Waypoints,
  category: "trade",
  window: { w: 440, h: 520 },
  load: () => import("./Window"),
  requiresWallet: true,
  release: "r0",
};
