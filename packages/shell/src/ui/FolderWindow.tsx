"use client";

import { useState } from "react";
import { CATEGORY_HUE, appHue, folderContents, itemCount, type AppCategory, type AppManifest } from "../core";
import { useDesktop } from "./desktop-context";
import { useRegistry } from "./registry";

type Open = (appId: string, from: HTMLElement) => void;

/**
 * One app in a folder window. A grey app is dimmed and tagged "Soon", and opens its "work in progress" window like
 * any other launch. While pointed at or focused, the app's name and blurb go to `onHint` for the status line.
 * Hookless, so a test can call it and press it.
 */
export function FolderItem({ m, onOpen, onHint }: { m: AppManifest; onOpen: Open; onHint: (text: string | null) => void }) {
  const hint = `${m.name}: ${m.blurb}`;
  return (
    <button
      type="button"
      className="os-icon"
      data-soon={m.comingSoon ? "true" : undefined}
      aria-label={m.comingSoon ? `${m.name}, work in progress` : m.name}
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
      {m.comingSoon && <span className="os-soon">Soon</span>}
    </button>
  );
}

/**
 * A folder opened as a window: its apps in a grid over a status line that reads "N items", or the name and blurb of
 * the app under the pointer or the keyboard focus.
 */
export function FolderWindow({ category, apps, onOpen }: { category: AppCategory; apps: readonly AppManifest[]; onOpen: Open }) {
  const [hint, setHint] = useState<string | null>(null);
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
  return <FolderWindow category={category} apps={folderContents(list, category)} onOpen={(id, from) => open(id, {}, from)} />;
}
