import { ShieldCheck } from "lucide-react";
import type { AppManifest } from "@arcos/shell";

/** A singleton: the window reads a new `token` param in an effect, as the shell replaces params on an open window. */
export const watchdog: AppManifest = {
  id: "watchdog",
  name: "Watchdog",
  blurb: "Alerts when a token you hold changes",
  icon: ShieldCheck,
  category: "trust",
  window: { w: 480, h: 560 },
  load: () => import("./Window"),
  acceptsDrop: ["token"],
  requiresWallet: true,
  release: "r1",
};
