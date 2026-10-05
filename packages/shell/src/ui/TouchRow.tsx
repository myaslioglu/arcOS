"use client";

import { appHue, appTag, type AppManifest } from "../core";

/**
 * One row of a touch list: the app's glyph, its name and one line of what it does. Touch has no hover to read a
 * tooltip by, so the line is always on. A grey app is tagged "Soon", and a tap opens its "work in progress" window;
 * a live app with a `tag` carries it the same way, and a blurb that only repeats the tag is left off.
 * The row hands itself to `onOpen`, so the window can open out of it.
 */
export function TouchRow({
  m,
  onOpen,
}: {
  m: AppManifest;
  onOpen: (appId: string, from: HTMLElement) => void;
}) {
  const tag = appTag(m);
  return (
    <li>
      <button
        type="button"
        onClick={(e) => onOpen(m.id, e.currentTarget)}
        className="os-touch-row"
        data-soon={m.comingSoon ? "true" : undefined}
        style={{ "--os-hue": appHue(m) } as React.CSSProperties}
      >
        <span className="os-icon-tile os-icon-tile--sm">
          <m.icon size={16} aria-hidden />
        </span>
        <span className="os-touch-text">
          <span className="os-touch-title-row">
            <span className="os-touch-title">{m.name}</span>
            {tag && <span className="os-soon">{tag}</span>}
          </span>
          {m.blurb !== tag && <span className="os-touch-blurb">{m.blurb}</span>}
        </span>
      </button>
    </li>
  );
}
