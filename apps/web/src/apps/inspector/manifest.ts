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
  // One window per token on Arc, keyed as it always was, and one per token on each other chain ("base:0x…").
  instanceKey: (p) => (p.chain && p.chain !== "arc" ? `${p.chain}:${(p.token ?? "").toLowerCase()}` : (p.token ?? "").toLowerCase()),
  requiresWallet: false,
  release: "r0",
  pinned: true,
};
