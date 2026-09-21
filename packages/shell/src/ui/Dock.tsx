"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { LayoutGrid, X } from "lucide-react";
import type { AppManifest, DesktopWindow, DragItem } from "../core";
import { useRegistry } from "./registry";
import { useDropTarget } from "./dnd";

/** Magnification: the pointed-at tile grows by up to this much… */
const MAG = 0.38;
/** …and its neighbours less, fading out over this many pixels. */
const REACH = 112;
/** How long a tile bounces after it launches its app. */
const BOUNCE_MS = 720;

/** Props a tile spreads on to show its name in the label above the dock. */
type Labelled = {
  "aria-label": string;
  onPointerEnter: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerLeave: () => void;
  onFocus: (e: React.FocusEvent<HTMLElement>) => void;
  onBlur: () => void;
};

type Props = {
  windows: DesktopWindow[];
  activeId: string | null;
  /** Hands over the tile, so the window can grow out of it. */
  onOpenPinned: (appId: string, from: HTMLElement) => void;
  onDropItem: (appId: string, item: DragItem, from: HTMLElement) => void;
  onFocus: (winId: string) => void;
  onClose: (winId: string) => void;
  onCloseAll: () => void;
  onLauncher: () => void;
};

/**
 * Centered bottom dock: search, the pinned apps, then one chip per open window.
 *
 * The apps are tiles, each in its own colour. Under a mouse the tiles swell
 * toward the pointer and ease back as it leaves, a tile that launches its
 * app bounces, and a new window's chip grows into place. All of it is
 * transform and opacity: the pointer handler runs once per frame, writes a
 * scale and a slide per item as custom properties and never touches layout.
 * Touch gets no swelling, and a reduced-motion setting turns all of it off.
 *
 * A window chip carries its app's glyph, so a stack of windows is findable
 * without reading every title. Clicking focuses or restores; right-click or
 * the × on hover closes without focusing first. The chips scroll in their own
 * strip, which leaves the tiles free to grow out of the dock.
 *
 * Buttons name themselves in a label above the dock on hover or focus, the
 * way a real dock does.
 */
export function Dock({ windows, activeId, onOpenPinned, onDropItem, onFocus, onClose, onCloseAll, onLauncher }: Props) {
  const registry = useRegistry();
  const pinned = useMemo(() => registry.list.filter((m) => m.pinned), [registry]);
  const [tip, setTip] = useState<{ text: string; x: number } | null>(null);
  const [bouncing, setBouncing] = useState<string | null>(null);
  const dockRef = useRef<HTMLElement>(null);
  const frame = useRef(0);
  const still = useRef(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const read = () => {
      still.current = query.matches;
    };
    read();
    query.addEventListener("change", read);
    return () => {
      query.removeEventListener("change", read);
      cancelAnimationFrame(frame.current);
    };
  }, []);

  useEffect(() => {
    if (!bouncing) return;
    const id = window.setTimeout(() => setBouncing(null), BOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [bouncing]);

  // Every tile swells by how near the pointer is; everything in the dock then
  // slides aside by the growth to its left, and the dock's backdrop widens by
  // the total, both centred, so no tile ever overlaps its neighbour. Centres
  // come from layout (offsetLeft), which a transform never moves, so a swollen
  // tile cannot feed back into its own size.
  const magnify = (clientX: number) => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const dock = dockRef.current;
      if (!dock) return;
      const x = clientX - dock.getBoundingClientRect().left;
      const kids = [...dock.children] as HTMLElement[];
      const grow = kids.map((el) => {
        if (!el.hasAttribute("data-mag")) return 0;
        const d = Math.abs(x - (el.offsetLeft + el.offsetWidth / 2));
        const pull = d >= REACH ? 0 : (1 + Math.cos((Math.PI * d) / REACH)) / 2;
        const m = 1 + MAG * pull;
        el.style.setProperty("--m", m.toFixed(3));
        return (m - 1) * el.offsetWidth;
      });
      const total = grow.reduce((sum, g) => sum + g, 0);
      let before = 0;
      kids.forEach((el, i) => {
        el.style.setProperty("--dx", `${(before + grow[i] / 2 - total / 2).toFixed(1)}px`);
        before += grow[i];
      });
      dock.style.setProperty("--dock-s", ((dock.offsetWidth + total) / dock.offsetWidth).toFixed(4));
    });
  };

  const settle = () => {
    cancelAnimationFrame(frame.current);
    const dock = dockRef.current;
    if (!dock) return;
    for (const el of dock.children as HTMLCollectionOf<HTMLElement>) {
      el.style.removeProperty("--m");
      el.style.removeProperty("--dx");
    }
    dock.style.removeProperty("--dock-s");
  };

  const show = (text: string, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setTip({ text, x: r.left + r.width / 2 });
  };
  const labelled = (text: string): Labelled => ({
    "aria-label": text,
    onPointerEnter: (e: React.PointerEvent<HTMLElement>) => {
      if (e.pointerType === "mouse") show(text, e.currentTarget);
    },
    onPointerLeave: () => setTip(null),
    onFocus: (e: React.FocusEvent<HTMLElement>) => show(text, e.currentTarget),
    onBlur: () => setTip(null),
  });

  return (
    <>
      <nav
        ref={dockRef}
        aria-label="dock and open windows"
        className="os-dock"
        onPointerMove={(e) => {
          if (e.pointerType === "mouse" && !still.current) magnify(e.clientX);
        }}
        onPointerLeave={settle}
      >
        <button
          type="button"
          onClick={onLauncher}
          data-cursor="hover"
          data-mag
          className="os-dock-btn os-dock-tile"
          style={{ "--os-hue": "var(--muted)" } as React.CSSProperties}
          {...labelled("Search  ⌘K / Ctrl+K")}
        >
          <span className="os-dock-face">
            <LayoutGrid className="os-dock-glyph" />
          </span>
        </button>
        <span className="os-dock-sep" aria-hidden />
        {pinned.map((m) => {
          const open = windows.some((w) => w.appId === m.id);
          return (
            <DockTile
              key={m.id}
              m={m}
              open={open}
              bouncing={bouncing === m.id}
              onOpenPinned={(e) => {
                if (!open && !still.current) setBouncing(m.id);
                onOpenPinned(m.id, e.currentTarget);
              }}
              onDropItem={onDropItem}
              labelled={labelled}
            />
          );
        })}
        {windows.length > 0 && <span className="os-dock-sep" aria-hidden />}
        {windows.length > 0 && (
          <span className="os-dock-wins">
            {windows.map((w) => {
              const Icon = registry.byId.get(w.appId)?.icon;
              const state = w.minimized ? " (minimized)" : "";
              return (
                <span key={w.winId} className="os-dock-win">
                  <button
                    type="button"
                    onClick={() => onFocus(w.winId)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      onClose(w.winId);
                    }}
                    data-cursor="hover"
                    aria-label={`${w.title}${state}`}
                    title={`${w.title}${state}`}
                    className={`os-dock-btn os-dock-btn--win ${w.winId === activeId ? "os-dock-btn--active" : ""} ${
                      w.minimized ? "os-dock-btn--min" : ""
                    }`}
                  >
                    {Icon && <Icon className="h-3.5 w-3.5 shrink-0" />}
                    <span className="os-dock-title">{w.title}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onClose(w.winId)}
                    data-cursor="hover"
                    aria-label={`close: ${w.title}`}
                    className="os-dock-x"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              );
            })}
          </span>
        )}
        {windows.length > 0 && (
          <>
            <span className="os-dock-sep" aria-hidden />
            <button
              type="button"
              onClick={onCloseAll}
              data-cursor="hover"
              className="os-dock-btn os-dock-btn--danger"
              {...labelled("Close all")}
            >
              <X className="h-4 w-4" />
            </button>
          </>
        )}
      </nav>
      {tip && (
        <span role="tooltip" className="os-dock-tip" style={{ left: tip.x }}>
          {tip.text}
        </span>
      )}
    </>
  );
}

function DockTile({
  m,
  open,
  bouncing,
  onOpenPinned,
  onDropItem,
  labelled,
}: {
  m: AppManifest;
  open: boolean;
  bouncing: boolean;
  onOpenPinned: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onDropItem: (appId: string, item: DragItem, from: HTMLElement) => void;
  labelled: (text: string) => Labelled;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const { over, props } = useDropTarget(m.comingSoon ? undefined : m.acceptsDrop, (item) => {
    if (ref.current) onDropItem(m.id, item, ref.current);
  });

  return (
    <button
      ref={ref}
      type="button"
      onClick={onOpenPinned}
      data-cursor="hover"
      data-mag
      data-drop={over ? "over" : undefined}
      className={`os-dock-btn os-dock-tile ${open ? "os-dock-btn--open" : ""}`}
      style={{ "--os-hue": m.hue ?? "var(--accent)" } as React.CSSProperties}
      {...labelled(m.name)}
      {...props}
    >
      <span className={`os-dock-face ${bouncing ? "os-dock-face--bounce" : ""}`}>
        <m.icon className="os-dock-glyph" />
      </span>
      {open && <span className="os-dock-dot" aria-hidden />}
    </button>
  );
}
