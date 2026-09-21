"use client";

import { useEffect, useRef, useState } from "react";
import { Minus, Square, X, Copy } from "lucide-react";
import {
  shouldEscapeCloseWindow,
  snapRect,
  snapZone,
  MIN_WINDOW,
  type DesktopWindow,
  type Rect,
  type SnapZone,
} from "../core";

type Props = {
  win: DesktopWindow;
  active: boolean;
  /** Where the window sits on the stage. Ignored when pinned. */
  rect: Rect;
  /** The stage's size: drag and resize limits, and where snaps land. */
  stage: { w: number; h: number };
  maximized: boolean;
  touch: boolean;
  onFocus: () => void;
  onMin: () => void;
  onMax: () => void;
  onClose: () => void;
  /** A drag, resize or snap finished: remember where the window ended up. */
  onRect: (rect: Rect) => void;
  children: React.ReactNode;
};

type Gesture =
  | { kind: "move"; x: number; y: number; left: number; top: number; moved: boolean }
  | { kind: "resize"; x: number; y: number; width: number; height: number; edge: Edge };

type Edge = "e" | "s" | "se";

/**
 * Single OS window, built like the rack's trays: a bezel frame, a plate for a
 * title bar with an LED that lights on the focused window, and an inset screen
 * for the body.
 *
 * It moves by its title bar and resizes from its right edge, bottom edge and
 * corner, through pointer events (mouse and pen; touch windows are pinned
 * full-screen instead). While a gesture runs it writes left/top/width/height
 * on the element directly, so dragging costs no React renders; when it ends,
 * the final rect goes up through `onRect` and becomes the window's own. Drag
 * the title bar into the left or right edge to snap to that half, into the
 * top edge to fill the stage; a translucent preview shows where it will land.
 *
 * Stacking: this frame never sets z-index on itself. The wrapper in
 * WindowManager owns the per-window z, and the stage owns the rack-vs-window
 * layer, so a drag can never reorder the window under the rack.
 */
export function WindowFrame({
  win,
  active,
  rect,
  stage,
  maximized,
  touch,
  onFocus,
  onMin,
  onMax,
  onClose,
  onRect,
  children,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [snap, setSnap] = useState<SnapZone | null>(null);

  // ESC closes the active window only; background windows stay put. An overlay above the window
  // (Launcher, a menu, a context menu) marks the key handled via preventDefault/stopPropagation
  // before this ever runs, and Escape aimed at a text field (dismissing autofill) never reaches
  // here as a close request either — see shouldEscapeCloseWindow.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (!shouldEscapeCloseWindow({ defaultPrevented: e.defaultPrevented, target: e.target as HTMLElement | null })) {
        return;
      }
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, onClose]);

  const pinned = maximized || touch;

  const measure = (): Rect | null => {
    const el = ref.current;
    if (!el) return null;
    return { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight };
  };

  const onTitlePointerDown = (e: React.PointerEvent) => {
    if (pinned) return;
    if ((e.target as HTMLElement).closest("button")) return;
    const el = ref.current;
    if (!el) return;
    gesture.current = {
      kind: "move",
      x: e.clientX,
      y: e.clientY,
      left: el.offsetLeft,
      top: el.offsetTop,
      moved: false,
    };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const onTitlePointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    const el = ref.current;
    if (!g || g.kind !== "move" || !el || pinned) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    // A click on the title is not a drag.
    if (!g.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    g.moved = true;
    el.style.left = `${Math.min(Math.max(0, g.left + dx), Math.max(0, stage.w - 120))}px`;
    el.style.top = `${Math.min(Math.max(0, g.top + dy), Math.max(0, stage.h - 48))}px`;
    const box = el.parentElement?.getBoundingClientRect();
    const zone = box ? snapZone(e.clientX - box.left, e.clientY - box.top, stage.w) : null;
    if (zone !== snap) setSnap(zone);
  };

  const endMove = () => {
    const g = gesture.current;
    gesture.current = null;
    const zone = snap;
    if (zone) setSnap(null);
    if (!g || g.kind !== "move" || !g.moved) return;
    if (zone === "top") {
      onMax();
      return;
    }
    const next = zone ? snapRect(zone, stage.w, stage.h) : measure();
    if (next) onRect(next);
  };

  const onResizeDown = (edge: Edge) => (e: React.PointerEvent) => {
    if (pinned) return;
    const el = ref.current;
    if (!el) return;
    e.stopPropagation();
    gesture.current = {
      kind: "resize",
      x: e.clientX,
      y: e.clientY,
      width: el.offsetWidth,
      height: el.offsetHeight,
      edge,
    };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const onResizeMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    const el = ref.current;
    if (!g || g.kind !== "resize" || !el) return;
    const maxW = Math.max(MIN_WINDOW.w, stage.w - el.offsetLeft - 8);
    const maxH = Math.max(MIN_WINDOW.h, stage.h - el.offsetTop - 8);
    if (g.edge !== "s") {
      el.style.width = `${Math.min(Math.max(MIN_WINDOW.w, g.width + e.clientX - g.x), maxW)}px`;
    }
    if (g.edge !== "e") {
      el.style.height = `${Math.min(Math.max(MIN_WINDOW.h, g.height + e.clientY - g.y), maxH)}px`;
    }
  };

  const endResize = () => {
    const g = gesture.current;
    gesture.current = null;
    if (!g || g.kind !== "resize") return;
    const next = measure();
    if (next) onRect(next);
  };

  const preview = snap
    ? snap === "top"
      ? snapRect("top", stage.w, stage.h)
      : snapRect(snap, stage.w, stage.h)
    : null;

  return (
    <>
      {preview && (
        <div
          aria-hidden
          className="os-snap"
          style={{ left: preview.left, top: preview.top, width: preview.width, height: preview.height }}
        />
      )}
      <div
        ref={ref}
        role="dialog"
        aria-label={win.title}
        onPointerDown={onFocus}
        style={
          pinned
            ? undefined
            : { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
        }
        className={[
          "os-window absolute",
          pinned ? "os-window--pinned inset-0" : "os-window--free",
          active ? "os-window--active" : "",
        ].join(" ")}
      >
        <div
          className="os-titlebar"
          onPointerDown={onTitlePointerDown}
          onPointerMove={onTitlePointerMove}
          onPointerUp={endMove}
          onPointerCancel={endMove}
          onDoubleClick={() => {
            if (!touch) onMax();
          }}
        >
          <span className="os-led" aria-hidden />
          <span className="os-title">{win.title}</span>
          <span className="os-controls">
            <button
              type="button"
              onClick={onMin}
              aria-label="minimize"
              data-cursor="hover"
              className="os-ctl"
            >
              <Minus className="h-3 w-3" />
            </button>
            {!touch && (
              <button
                type="button"
                onClick={onMax}
                aria-label={maximized ? "restore" : "maximize"}
                data-cursor="hover"
                className="os-ctl"
              >
                {maximized ? <Copy className="h-3 w-3" /> : <Square className="h-3 w-3" />}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="close"
              data-cursor="hover"
              className="os-ctl os-ctl--close"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        </div>
        <div className={win.flush ? "os-body os-body--flush" : "os-body"}>{children}</div>
        {!pinned &&
          (["e", "s", "se"] as const).map((edge) => (
            <span
              key={edge}
              aria-hidden
              className={`os-resize os-resize--${edge}`}
              onPointerDown={onResizeDown(edge)}
              onPointerMove={onResizeMove}
              onPointerUp={endResize}
              onPointerCancel={endResize}
            />
          ))}
      </div>
    </>
  );
}
