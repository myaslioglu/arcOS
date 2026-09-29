import { Trash2 } from "lucide-react";
import type { AppManifest } from "@arcos/shell";

export const revoke: AppManifest = {
  id: "revoke",
  name: "Revoke",
  blurb: "Remove token approvals",
  icon: Trash2,
  category: "system",
  window: { w: 520, h: 560 },
  load: () => import("./Window"),
  requiresWallet: false,
  release: "r1",
};
