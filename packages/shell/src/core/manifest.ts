import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import type { DesktopWindow, WindowAction, WindowSize } from "./types";

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

/**
 * Each group's colour, the one place an app's hue comes from: its tray and tiles in the rack, its
 * dock tile, launcher row and touch row, and its window's title-bar LED all use it, so an app looks
 * the same everywhere. Token names, so both themes resolve them.
 */
export const CATEGORY_HUE: Record<AppCategory, string> = {
  system: "var(--muted)",
  trust: "var(--accent-2)",
  create: "var(--accent-3)",
  trade: "var(--accent)",
};

export function appHue(m: Pick<AppManifest, "category">): string {
  return CATEGORY_HUE[m.category];
}

export type AppProps = { winId: string; params: Record<string, string> };

export type AppManifest = {
  id: string;
  name: string;
  /** One line under the name in the launcher and touch list. */
  blurb: string;
  icon: LucideIcon;
  /** Also picks the app's hue: see `CATEGORY_HUE`. */
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

/** The app id of a folder window. Its instance key, and its `group` param, is the category it shows. */
export const FOLDER_APP_ID = "folder";

/** Ids the desktop keeps for its own windows. No app may register one. */
export const RESERVED_APP_IDS: readonly string[] = [FOLDER_APP_ID];

export function isCategory(value: unknown): value is AppCategory {
  return typeof value === "string" && (CATEGORY_ORDER as readonly string[]).includes(value);
}

/**
 * A folder window big enough to show all `n` of its apps without scrolling: up to four across, the rest in rows.
 * Cells, padding and the status line match `.os-group-grid` and `.os-group-status` in styles/desk.css.
 */
export function folderWindowSize(n: number): WindowSize {
  const cols = n <= 4 ? Math.max(n, 2) : n <= 6 ? 3 : 4;
  const rows = Math.max(1, Math.ceil(n / cols));
  return { w: Math.max(380, cols * 116 + 56), h: 110 + rows * 94 };
}

export function buildRegistry(list: AppManifest[]): Registry {
  const byId = new Map<string, AppManifest>();
  for (const m of list) {
    if (RESERVED_APP_IDS.includes(m.id)) throw new Error(`"${m.id}" is kept for the desktop's own windows`);
    if (byId.has(m.id)) throw new Error(`duplicate app id "${m.id}"`);
    byId.set(m.id, m);
  }
  return { list, byId };
}

type OpenAction = Extract<WindowAction, { type: "open" }>;

/**
 * What opening `appId` means. A registered app opens its own window, one per instance key. `FOLDER_APP_ID` opens the
 * folder window of the category in `params.group`, keyed by that category, so a second click focuses the same window.
 * An unknown id, and a folder of an unknown or empty category, open nothing.
 */
export function openActionFor(
  registry: Registry,
  appId: string,
  params: Record<string, string>,
): OpenAction | null {
  if (appId === FOLDER_APP_ID) {
    const group = params.group;
    if (!isCategory(group)) return null;
    const count = registry.list.filter((m) => m.category === group).length;
    if (count === 0) return null;
    return {
      type: "open",
      appId: FOLDER_APP_ID,
      instanceKey: group,
      params: { group },
      title: CATEGORY_LABEL[group],
      size: folderWindowSize(count),
      flush: true,
    };
  }
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

/** The badge beside a window's title. */
export type WindowKind = "folder";
export const KIND_LABEL: Record<WindowKind, string> = { folder: "folder" };

/** How a window's frame looks: the hue of its LED and border, its kind badge, and the app behind it (none for the desktop's own windows). */
export type WindowLook = { hue: string | null; kind: WindowKind | null; app: AppManifest | null };

export function windowLook(registry: Registry, win: Pick<DesktopWindow, "appId" | "instanceKey">): WindowLook {
  if (win.appId === FOLDER_APP_ID) {
    return { hue: isCategory(win.instanceKey) ? CATEGORY_HUE[win.instanceKey] : null, kind: "folder", app: null };
  }
  const app = registry.byId.get(win.appId) ?? null;
  return { hue: app ? appHue(app) : null, kind: null, app };
}
