"use client";

import { CATEGORY_ORDER, folderContents, type AppCategory, type AppManifest } from "../core";
import { FolderCell } from "./DeskCells";

/**
 * The desk, the Folders view: a folder for each category that has apps, in the rack's order, down the first column
 * of a grid that leaves the rest of the wallpaper open. A single click or Enter opens a folder; there is no
 * double-click, so touch and keyboard behave the same.
 */
export function DeskFolders({
  apps,
  onOpenFolder,
}: {
  apps: readonly AppManifest[];
  onOpenFolder: (category: AppCategory, from: HTMLElement) => void;
}) {
  const folders = CATEGORY_ORDER.map((category) => ({ category, apps: folderContents(apps, category) })).filter(
    (f) => f.apps.length > 0,
  );
  return (
    <div className="os-desk" role="group" aria-label="Desktop">
      {folders.map((f) => (
        <FolderCell key={f.category} category={f.category} apps={f.apps} onOpen={onOpenFolder} />
      ))}
    </div>
  );
}
