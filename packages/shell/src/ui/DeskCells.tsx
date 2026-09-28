"use client";

import { CATEGORY_HUE, CATEGORY_LABEL, itemCount, type AppCategory, type AppManifest, type DeskItem } from "../core";
import { DeskGlyph } from "./DeskGlyph";
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

/**
 * A desktop item: its file or link art over its caption. A link is an `<a>` that opens in a new tab with no opener;
 * a file is a button that hands itself to `onOpen`, so its window grows out of it. `loose` stands it in the desk's
 * last column. Hookless, so a test can call it and press it.
 */
export function DeskItemCell({
  item,
  loose,
  onOpen,
}: {
  item: DeskItem;
  loose: boolean;
  onOpen: (item: DeskItem, from: HTMLElement) => void;
}) {
  const className = loose ? "os-desk-cell os-desk-cell--loose" : "os-desk-cell";
  const style = { "--os-hue": item.hue } as React.CSSProperties;
  if (item.action.kind === "href") {
    const label = `${item.label}: ${item.blurb} (opens in a new tab)`;
    return (
      <a
        href={item.action.href}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
        style={style}
        aria-label={label}
        title={label}
      >
        <DeskGlyph item={item} />
        <span className="os-desk-name">{item.label}</span>
      </a>
    );
  }
  const label = `${item.label}: ${item.blurb}`;
  return (
    <button
      type="button"
      onClick={(e) => onOpen(item, e.currentTarget)}
      className={className}
      style={style}
      aria-label={label}
      title={label}
    >
      <DeskGlyph item={item} />
      <span className="os-desk-name">{item.label}</span>
    </button>
  );
}
