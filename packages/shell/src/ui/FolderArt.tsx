"use client";

import type { AppManifest } from "../core";

/**
 * A folder drawn from its contents: a back panel with a tab, a card for each of the first three apps carrying that
 * app's glyph, and a front flap with an LED and the count of every app inside, grey ones included. Hovering or
 * focusing the cell around it tips the flap and lifts the cards (transforms only, and only without a reduced-motion
 * setting; see `.os-folder` in desk.css).
 *
 * Decorative: the button around it carries the folder's name and count.
 */
export function FolderArt({ apps, hue }: { apps: readonly AppManifest[]; hue: string }) {
  const cards = apps.slice(0, 3);
  return (
    <span className="os-folder" style={{ "--os-group": hue } as React.CSSProperties} aria-hidden>
      <span className="os-folder-back" />
      <span className="os-folder-cards" style={{ "--n": cards.length } as React.CSSProperties}>
        {cards.map((m, i) => (
          <span key={m.id} className="os-folder-card" style={{ "--i": i } as React.CSSProperties}>
            <m.icon className="os-folder-glyph" aria-hidden />
          </span>
        ))}
      </span>
      <span className="os-folder-front">
        <span className="os-folder-led" />
        <span className="os-folder-count">{apps.length}</span>
      </span>
    </span>
  );
}
