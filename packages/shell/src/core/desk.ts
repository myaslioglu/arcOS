import type { LucideIcon } from "lucide-react";
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

/** What a desk item does when opened: open an app's window, or follow a link in a new tab. */
export type DeskItemAction = { kind: "app"; appId: string } | { kind: "href"; href: string };

/**
 * A desktop item, down the desk's last column: a text file that opens a window, or a link out. The web app supplies
 * them (DesktopShell's `deskItems`); the shell draws them with the file and tile art.
 */
export type DeskItem = {
  id: string;
  /** The caption under the art: "readme.txt", "GitHub". */
  label: string;
  /** One line on what it is, for its accessible name. */
  blurb: string;
  /** "file": a page with a folded corner and `ext` along its foot. "link": a desk-sized tile with the ↗ badge. */
  art: "file" | "link";
  ext?: string;
  icon: LucideIcon;
  /** A colour token, such as "var(--muted)". */
  hue: string;
  action: DeskItemAction;
};

/** The View menu's names for the desktop's views. */
export const VIEW_LABEL: Record<DesktopView, string> = { folders: "Folders", trays: "Trays" };

/** The same choice's names on touch, where the touch switch (TouchHome) and the View menu's Desktop
 * group must read the same way: on a phone, the rack's trays read as a list. The stored `arcos-view`
 * value is unchanged either way — "trays" — only its label differs by pointer. */
export const TOUCH_VIEW_LABEL: Record<DesktopView, string> = { folders: "Folders", trays: "List" };
