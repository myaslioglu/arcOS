import { CircleQuestionMark } from "lucide-react";
import type { AppManifest } from "@arcos/shell";

/**
 * Help: a short guide to ArcOS, opened by the Help item on the desk (lib/desk-items.ts), the menu bar's Help menu and
 * the launcher. Its list of apps is the registry's own (useRegistry), so it always matches this site's network.
 */
export const help: AppManifest = {
  id: "help",
  name: "Help",
  blurb: "Start here: a short guide to ArcOS",
  icon: CircleQuestionMark,
  category: "system",
  window: { w: 640, h: 620 },
  load: () => import("./Window"),
  requiresWallet: false,
  release: "r0",
};
