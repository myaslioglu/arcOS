import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import type { WindowAction, WindowSize } from "./types";

// Only "token" can be decoded today (see dnd.ts's decodeDragItem). Widen this together with
// DragItem and its decoder when a manifest actually needs to declare one of the other kinds —
// otherwise a future manifest could declare a kind that highlights a drop target and then silently
// swallows every drop on it.
export type DropKind = "token";
export type AppCategory = "system" | "trust" | "create" | "trade";

export const CATEGORY_ORDER: AppCategory[] = ["system", "trust", "create", "trade"];
export const CATEGORY_LABEL: Record<AppCategory, string> = {
  system: "System",
  trust: "Trust",
  create: "Create",
  trade: "Trade",
};

export type AppProps = { winId: string; params: Record<string, string> };

export type AppManifest = {
  id: string;
  name: string;
  /** One line under the name in the launcher and touch list. */
  blurb: string;
  icon: LucideIcon;
  /** CSS color for the icon tile; falls back to the accent. */
  hue?: string;
  category: AppCategory;
  window: WindowSize & { flush?: boolean };
  load: () => Promise<{ default: ComponentType<AppProps> }>;
  /** Kinds of dragged item this app's icon and window accept. */
  acceptsDrop?: DropKind[];
  /** Several windows of this app, keyed by params. Omit for a singleton. */
  instanceKey?: (params: Record<string, string>) => string;
  /** Descriptive metadata only — not read by the shell today. */
  requiresWallet: boolean;
  /** Descriptive metadata only — not read by the shell today. */
  release: "r0" | "r1" | "r2" | "phase2";
  /** Shown in the dock even when closed. */
  pinned?: boolean;
  /** Listed but not openable yet (greyed icon). */
  comingSoon?: boolean;
};

export type Registry = { list: AppManifest[]; byId: Map<string, AppManifest> };

export function buildRegistry(list: AppManifest[]): Registry {
  const byId = new Map<string, AppManifest>();
  for (const m of list) {
    if (byId.has(m.id)) throw new Error(`duplicate app id "${m.id}"`);
    byId.set(m.id, m);
  }
  return { list, byId };
}

type OpenAction = Extract<WindowAction, { type: "open" }>;

export function openActionFor(
  registry: Registry,
  appId: string,
  params: Record<string, string>,
): OpenAction | null {
  const m = registry.byId.get(appId);
  if (!m || m.comingSoon) return null;
  return {
    type: "open",
    appId: m.id,
    instanceKey: m.instanceKey ? m.instanceKey(params) : "",
    params,
    title: m.name,
    size: { w: m.window.w, h: m.window.h },
    flush: m.window.flush ?? false,
  };
}
