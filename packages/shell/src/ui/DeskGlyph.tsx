"use client";

import { ArrowUpRight } from "lucide-react";
import type { DeskItem } from "../core";

/**
 * A desk item's art, at folder size. A file is a page with a folded corner, its glyph, and its extension along the
 * foot. A link is the rack's tile at desk size, with the arrow every shortcut carries in its corner. Decorative: the
 * cell around it carries the name.
 */
export function DeskGlyph({ item }: { item: DeskItem }) {
  if (item.art === "link") {
    return (
      <span className="os-icon-tile os-icon-tile--lg os-shortcut" aria-hidden>
        <item.icon className="os-shortcut-glyph" />
        <span className="os-shortcut-arrow">
          <ArrowUpRight />
        </span>
      </span>
    );
  }
  return (
    <span className="os-file" aria-hidden>
      <svg viewBox="0 0 54 66" className="os-file-page">
        <path
          className="os-file-sheet"
          d="M6 1.5H36L52.5 18V60a4.5 4.5 0 0 1-4.5 4.5H6A4.5 4.5 0 0 1 1.5 60V6A4.5 4.5 0 0 1 6 1.5Z"
        />
        <path className="os-file-fold" d="M36 1.5V13.5a4.5 4.5 0 0 0 4.5 4.5H52.5" />
      </svg>
      <item.icon className="os-file-glyph" />
      {item.ext && <span className="os-file-ext">{item.ext}</span>}
    </span>
  );
}
