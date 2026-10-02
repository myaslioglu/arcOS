"use client";

import { useState } from "react";
import { CATEGORY_HUE, appHue, appLabel, appTag, folderContents, itemCount, type AppCategory, type AppManifest } from "../core";
import { useDesktop } from "./desktop-context";
import { useIsTouch } from "./hooks/useIsTouch";
import { useRegistry } from "./registry";
import { TouchRow } from "./TouchRow";

type Open = (appId: string, from: HTMLElement) => void;

/**
 * One app in a folder window. A grey app is dimmed and tagged "Soon", and opens its "work in progress" window like
 * any other launch; a live app with a `tag` carries it the same way, at full strength. While pointed at or focused, the app's name and blurb go to `onHint` for the status line.
 * Hookless, so a test can call it and press it.
 */
export function FolderItem({ m, onOpen, onHint }: { m: AppManifest; onOpen: Open; onHint: (text: string | null) => void }) {
  const hint = `${m.name}: ${m.blurb}`;
  const tag = appTag(m);
  return (
    <button
      type="button"
      className="os-icon"
      data-soon={m.comingSoon ? "true" : undefined}
      aria-label={appLabel(m)}
      style={{ "--os-hue": appHue(m) } as React.CSSProperties}
      onClick={(e) => onOpen(m.id, e.currentTarget)}
      onPointerEnter={() => onHint(hint)}
      onPointerLeave={() => onHint(null)}
      onFocus={() => onHint(hint)}
      onBlur={() => onHint(null)}
    >
      <span className="os-icon-tile">
        <m.icon size={20} aria-hidden />
      </span>
      <span className="os-icon-name">{m.name}</span>
      {tag && <span className="os-soon">{tag}</span>}
    </button>
  );
}

/**
 * A folder opened as a window. With a pointer: its apps in a grid over a status line that reads "N items", or the name
 * and blurb of the app under the pointer or the keyboard focus. On touch, where nothing is pointed at: its apps as
 * rows that carry their blurbs, grey ones tagged "Soon".
 */
export function FolderWindow({
  category,
  apps,
  touch = false,
  onOpen,
}: {
  category: AppCategory;
  apps: readonly AppManifest[];
  touch?: boolean;
  onOpen: Open;
}) {
  const [hint, setHint] = useState<string | null>(null);
  if (touch) {
    return (
      <ul className="os-touch-list os-group-rows" style={{ "--os-group": CATEGORY_HUE[category] } as React.CSSProperties}>
        {apps.map((m) => (
          <TouchRow key={m.id} m={m} onOpen={onOpen} />
        ))}
      </ul>
    );
  }
  return (
    <div className="os-group" style={{ "--os-group": CATEGORY_HUE[category] } as React.CSSProperties}>
      <div className="os-group-grid">
        {apps.map((m) => (
          <FolderItem key={m.id} m={m} onOpen={onOpen} onHint={setHint} />
        ))}
      </div>
      <p className="os-group-status">{hint ?? itemCount(apps.length)}</p>
    </div>
  );
}

/** The folder window as the desktop mounts it: the registry's apps in `category`, each opening out of its icon. */
export function FolderBody({ category }: { category: AppCategory }) {
  const { list } = useRegistry();
  const { open } = useDesktop();
  const touch = useIsTouch();
  return (
    <FolderWindow
      category={category}
      apps={folderContents(list, category)}
      touch={touch}
      onOpen={(id, from) => open(id, {}, from)}
    />
  );
}
