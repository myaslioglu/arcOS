import { FolderOpen } from "lucide-react";
import type { AppManifest } from "@arcos/shell";

export const finder: AppManifest = {
  id: "finder",
  name: "Finder",
  blurb: "Your tokens, as files you can drag",
  icon: FolderOpen,
  category: "system",
  window: { w: 600, h: 480 },
  load: () => import("./Window"),
  requiresWallet: true,
  release: "r0",
  pinned: true,
};
