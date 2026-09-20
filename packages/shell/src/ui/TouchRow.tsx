"use client";

import type { AppManifest } from "../core";

/**
 * One row of a touch list: the app's glyph, its name and one line of what it
 * does. Touch has no hover to read a tooltip by, so the line is always on.
 * The row hands itself to `onOpen`, so the window can open out of it.
 */
export function TouchRow({
  m,
  onOpen,
}: {
  m: AppManifest;
  onOpen: (appId: string, from: HTMLElement) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={(e) => onOpen(m.id, e.currentTarget)}
        className="os-touch-row"
        style={m.hue ? ({ "--os-hue": m.hue } as React.CSSProperties) : undefined}
      >
        <span className="os-icon-tile os-icon-tile--sm">
          <m.icon size={16} strokeWidth={1.6} aria-hidden />
        </span>
        <span className="os-touch-text">
          <span className="os-touch-title">{m.name}</span>
          <span className="os-touch-blurb">{m.blurb}</span>
        </span>
      </button>
    </li>
  );
}
