"use client";

import { CATEGORY_HUE, CATEGORY_LABEL, itemCount, type AppCategory, type AppManifest } from "../core";
import { FolderArt } from "./FolderArt";

/**
 * A folder on the desk: its art over its name. The button names the folder and its count ("Trust: 4 items") for
 * assistive technology; a click or Enter hands the cell to `onOpen`, so the folder's window grows out of it.
 * Hookless, so a test can call it and press it.
 */
export function FolderCell({
  category,
  apps,
  onOpen,
}: {
  category: AppCategory;
  apps: readonly AppManifest[];
  onOpen: (category: AppCategory, from: HTMLElement) => void;
}) {
  const name = CATEGORY_LABEL[category];
  const label = `${name}: ${itemCount(apps.length)}`;
  return (
    <button
      type="button"
      onClick={(e) => onOpen(category, e.currentTarget)}
      data-group={category}
      aria-label={label}
      title={label}
      className="os-desk-cell"
      style={{ "--os-group": CATEGORY_HUE[category] } as React.CSSProperties}
    >
      <FolderArt apps={apps} hue={CATEGORY_HUE[category]} />
      <span className="os-desk-name">{name}</span>
    </button>
  );
}
