import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import type { DesktopWindow, WindowAction, WindowSize } from "./types";

// Every kind here has a decoder in dnd.ts (decodeDragItem). Widen this together with DragItem and
// its decoder, never alone — otherwise a manifest could declare a kind that highlights a drop target
// and then silently swallows every drop on it. "approval" is Revoke's row; no manifest accepts it on
// an icon today (Revoke's own trash area takes it).
export type DropKind = "token" | "approval";
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
  /** Which release ships the app. For a grey app it also names its stage (see `stageLabel` in roadmap.ts). */
  release: "r0" | "r1" | "r2" | "phase2";
  /** Shown in the dock even when closed. */
  pinned?: boolean;
  /** Listed but not live yet: greyed, and it opens a small "work in progress" window instead of the app. */
  comingSoon?: boolean;
  /** A short tag beside the app's name on its tile, its row and its menu entry, such as "Soon". A grey app is tagged
   * "Soon" on its own, so it needs none. */
  tag?: string;
  /** A grey app's two or three sentences on what it will do, shown in its "work in progress" window. */
  details?: string[];
};

/** The tag beside an app's name, if any: "Soon" for a grey app, otherwise its manifest's `tag`. */
export function appTag(m: Pick<AppManifest, "comingSoon" | "tag">): string | null {
  return m.comingSoon ? "Soon" : (m.tag ?? null);
}

/**
 * An app's accessible name where it is listed: its name, with "work in progress" for a grey app, or its tag for a
 * tagged one ("<name>, <tag>"), so the tag reaches a screen reader as the tile shows it.
 */
export function appLabel(m: Pick<AppManifest, "name" | "comingSoon" | "tag">): string {
  if (m.comingSoon) return `${m.name}, work in progress`;
  return m.tag ? `${m.name}, ${m.tag.toLowerCase()}` : m.name;
}

export type Registry = { list: AppManifest[]; byId: Map<string, AppManifest> };

/** The app id of a folder window. Its instance key, and its `group` param, is the category it shows. */
export const FOLDER_APP_ID = "folder";

/** The app id of the Roadmap window, which lists the grey apps and their stages. */
export const ROADMAP_APP_ID = "roadmap";

/** Ids the desktop keeps for its own windows. No app may register one. */
export const RESERVED_APP_IDS: readonly string[] = [FOLDER_APP_ID, ROADMAP_APP_ID];

/** A grey app's "work in progress" window. */
export const WIP_WINDOW: WindowSize = { w: 380, h: 300 };

export const ROADMAP_WINDOW: WindowSize = { w: 460, h: 420 };

export function isCategory(value: unknown): value is AppCategory {
  return typeof value === "string" && (CATEGORY_ORDER as readonly string[]).includes(value);
}

/**
 * A folder window big enough to show all `n` of its apps without scrolling: up to four across, the rest in rows.
 * Cells, padding, the 4px gap between rows and the status line match `.os-group-grid` and `.os-group-status` in
 * styles/desk.css. Every row budgets 102px, tall enough for a row that holds a grey app (its "Soon" tag measures
 * about 102px, against a plain row's 94px): simpler than sizing each row by whether it happens to hold one, at the
 * cost of a little slack on a folder with none.
 */
export function folderWindowSize(n: number): WindowSize {
  const cols = n <= 4 ? Math.max(n, 2) : n <= 6 ? 3 : 4;
  const rows = Math.max(1, Math.ceil(n / cols));
  return { w: Math.max(380, cols * 116 + 56), h: 110 + rows * 102 + (rows - 1) * 4 };
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
 * What opening `appId` means. A registered app opens its own window, one per instance key; a grey app opens a small
 * "work in progress" window instead, whatever params it was given. `FOLDER_APP_ID` opens the folder window of the
 * category in `params.group`, keyed by that category, so a second click focuses the same window, and
 * `ROADMAP_APP_ID` opens the Roadmap. An unknown id, and a folder of an unknown or empty category, open nothing.
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
  if (appId === ROADMAP_APP_ID) {
    return {
      type: "open",
      appId: ROADMAP_APP_ID,
      instanceKey: "",
      params: {},
      title: "Roadmap",
      size: { ...ROADMAP_WINDOW },
      flush: false,
    };
  }
  const m = registry.byId.get(appId);
  if (!m) return null;
  if (m.comingSoon) {
    return { type: "open", appId: m.id, instanceKey: "", params: {}, title: m.name, size: { ...WIP_WINDOW }, flush: false };
  }
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
export type WindowKind = "folder" | "wip";
export const KIND_LABEL: Record<WindowKind, string> = { folder: "folder", wip: "work in progress" };

/** How a window's frame looks: the hue of its LED and border, its kind badge, and the app behind it (none for the desktop's own windows). */
export type WindowLook = { hue: string | null; kind: WindowKind | null; app: AppManifest | null };

export function windowLook(registry: Registry, win: Pick<DesktopWindow, "appId" | "instanceKey">): WindowLook {
  if (win.appId === FOLDER_APP_ID) {
    return { hue: isCategory(win.instanceKey) ? CATEGORY_HUE[win.instanceKey] : null, kind: "folder", app: null };
  }
  if (win.appId === ROADMAP_APP_ID) return { hue: CATEGORY_HUE.system, kind: null, app: null };
  const app = registry.byId.get(win.appId) ?? null;
  return { hue: app ? appHue(app) : null, kind: app?.comingSoon ? "wip" : null, app };
}
