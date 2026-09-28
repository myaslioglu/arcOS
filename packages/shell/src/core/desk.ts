import type { AppCategory, AppManifest } from "./manifest";

/**
 * How the desktop lays out its apps: as folders on a desk (the default, the way a computer's desktop looks) or as the
 * rack of trays. Kept in localStorage under `VIEW_STORAGE_KEY` (see ui/view.ts); anything but a known view reads as the
 * default, so a stale or hand-edited value can't break the desktop.
 */
export const DESKTOP_VIEWS = ["folders", "trays"] as const;
export type DesktopView = (typeof DESKTOP_VIEWS)[number];

export const DEFAULT_VIEW: DesktopView = "folders";

/** Where the choice lives in localStorage. */
export const VIEW_STORAGE_KEY = "arcos-view";

export function parseStoredView(raw: string | null): DesktopView {
  return raw === "folders" || raw === "trays" ? raw : DEFAULT_VIEW;
}

/** A category's apps, in registry order, grey ones included: what its folder holds and counts. */
export function folderContents(list: readonly AppManifest[], category: AppCategory): AppManifest[] {
  return list.filter((m) => m.category === category);
}

/** "1 item", "5 items": a folder's count in words, for its label and its window's status line. */
export function itemCount(n: number): string {
  return `${n} ${n === 1 ? "item" : "items"}`;
}
