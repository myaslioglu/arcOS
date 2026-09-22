"use client";

import { useEffect, useRef } from "react";

/** Roughly the menu's size, to keep it on screen near a corner. */
const SIZE = { w: 236, h: 170 };

type Props = {
  x: number;
  y: number;
  hasWindows: boolean;
  onClose: () => void;
  onTile: () => void;
  onMinimizeAll: () => void;
  onCloseAll: () => void;
  onAbout: () => void;
};

/**
 * Right-click on the desktop itself: the things a desktop is for. It opens
 * at the pointer, stays on screen, takes focus on its first item and closes
 * on Esc, on any click elsewhere, or when the window loses focus.
 */
export function ContextMenu({ x, y, hasWindows, onClose, onTile, onMinimizeAll, onCloseAll, onAbout }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? i + 1 : i - 1 + items.length;
    items[next % items.length]?.focus();
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="desktop menu"
      onKeyDown={onKeyDown}
      className="os-ctx"
      style={{
        left: Math.max(8, Math.min(x, window.innerWidth - SIZE.w - 8)),
        top: Math.max(8, Math.min(y, window.innerHeight - SIZE.h - 8)),
      }}
    >
      <button type="button" role="menuitem" className="os-menu-item" disabled={!hasWindows} onClick={run(onTile)}>
        <span className="os-menu-check" aria-hidden />
        <span className="os-menu-label">Tile windows</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className="os-menu-item"
        disabled={!hasWindows}
        onClick={run(onMinimizeAll)}
      >
        <span className="os-menu-check" aria-hidden />
        <span className="os-menu-label">Minimize all</span>
      </button>
      <button type="button" role="menuitem" className="os-menu-item" disabled={!hasWindows} onClick={run(onCloseAll)}>
        <span className="os-menu-check" aria-hidden />
        <span className="os-menu-label">Close all</span>
      </button>
      <div role="separator" className="os-menu-sep" />
      <button type="button" role="menuitem" className="os-menu-item" onClick={run(onAbout)}>
        <span className="os-menu-check" aria-hidden />
        <span className="os-menu-label">About 4rc.OS</span>
      </button>
    </div>
  );
}
