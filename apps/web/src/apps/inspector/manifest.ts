import { ScanSearch } from "lucide-react";
import type { AppManifest } from "@arcos/shell";
import { inspectorKey } from "@/lib/inspect-chain-pick";

export const inspector: AppManifest = {
  id: "inspector",
  name: "Inspector",
  blurb: "What a token's contract can do to you",
  icon: ScanSearch,
  category: "trust",
  window: { w: 540, h: 640 },
  load: () => import("./Window"),
  acceptsDrop: ["token"],
  // One window per token on Arc, keyed as it always was, and one per token on each other chain ("base:0x…"), with the
  // chain read as the window reads it: see inspectorKey.
  instanceKey: inspectorKey,
  requiresWallet: false,
  release: "r0",
  pinned: true,
};
