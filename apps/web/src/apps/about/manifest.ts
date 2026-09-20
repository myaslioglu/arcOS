import { Info } from "lucide-react";
import type { AppManifest } from "@arcos/shell";

export const about: AppManifest = {
  id: "about",
  name: "About",
  blurb: "What ARC.os is",
  icon: Info,
  category: "system",
  window: { w: 460, h: 360 },
  load: () => import("./Window"),
  requiresWallet: false,
  release: "r0",
  pinned: true,
};
