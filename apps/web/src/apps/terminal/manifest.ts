import { SquareTerminal } from "lucide-react";
import type { AppManifest } from "@arcos/shell";

export const terminal: AppManifest = {
  id: "terminal",
  name: "Terminal",
  blurb: "Open apps and read the chain by typing",
  icon: SquareTerminal,
  category: "system",
  window: { w: 640, h: 420, flush: true },
  load: () => import("./Window"),
  requiresWallet: false,
  release: "r1",
};
