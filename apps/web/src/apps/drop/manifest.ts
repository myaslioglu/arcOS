import { Send } from "lucide-react";
import type { AppManifest } from "@arcos/shell";

export const drop: AppManifest = {
  id: "drop",
  name: "Drop",
  blurb: "Send a token to many wallets at once",
  icon: Send,
  category: "create",
  window: { w: 560, h: 640 },
  load: () => import("./Window"),
  acceptsDrop: ["token"],
  requiresWallet: true,
  release: "r0",
  pinned: true,
};
