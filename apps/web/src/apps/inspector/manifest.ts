import { ScanSearch } from "lucide-react";
import type { AppManifest } from "@arcos/shell";

export const inspector: AppManifest = {
  id: "inspector",
  name: "Inspector",
  blurb: "What a token's contract can do to you",
  icon: ScanSearch,
  category: "trust",
  window: { w: 540, h: 640 },
  load: () => import("./Window"),
  acceptsDrop: ["token"],
  instanceKey: (p) => (p.token ?? "").toLowerCase(),
  requiresWallet: false,
  release: "r0",
  pinned: true,
};
