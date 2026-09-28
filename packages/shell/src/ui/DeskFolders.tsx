"use client";

import { CATEGORY_ORDER, folderContents, type AppCategory, type AppManifest, type DeskItem } from "../core";
import { DeskItemCell, FolderCell } from "./DeskCells";

/**
 * The desk, the Folders view: a folder for each category that has apps, in the rack's order, down the first column,
 * and the desk items down the last, with the wallpaper open between them. A single click or Enter opens a folder or a
 * file; a link opens in a new tab. There is no double-click, so touch and keyboard behave the same.
 */
export function DeskFolders({
  apps,
  items,
  onOpenFolder,
  onOpenItem,
}: {
  apps: readonly AppManifest[];
  items: readonly DeskItem[];
  onOpenFolder: (category: AppCategory, from: HTMLElement) => void;
  onOpenItem: (item: DeskItem, from: HTMLElement) => void;
}) {
  const folders = CATEGORY_ORDER.map((category) => ({ category, apps: folderContents(apps, category) })).filter(
    (f) => f.apps.length > 0,
  );
  return (
    <div className="os-desk" role="group" aria-label="Desktop">
      {folders.map((f) => (
        <FolderCell key={f.category} category={f.category} apps={f.apps} onOpen={onOpenFolder} />
      ))}
      {items.map((item) => (
        <DeskItemCell key={item.id} item={item} loose onOpen={onOpenItem} />
      ))}
    </div>
  );
}
