"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { clampRect, windowRect, type DesktopWindow } from "../core";
import { WindowFrame } from "./WindowFrame";
import type { WindowActions } from "./hooks/useWindowManager";

/** A point on the stage, in stage pixels. */
export type Origin = { x: number; y: number };

type Props = {
  windows: DesktopWindow[];
  activeId: string | null;
  actions: WindowActions;
  touch: boolean;
  renderBody: (win: DesktopWindow) => React.ReactNode;
  /**
   * Where each window was opened from, keyed `appId:instanceKey`: the folder, icon or
   * dock tile that was clicked. A window with an origin grows out of it and
   * shrinks back into it on close; one opened from the launcher, a link or a
   * command fades in where it lands.
   */
  origins?: Record<string, Origin>;
};

const EASE = [0.22, 1, 0.36, 1] as const;
/** Gentler at the start than EASE, so the growth out of the icon reads. */
const ZOOM = [0.2, 0.75, 0.25, 1] as const;

/**
 * Stacks open windows. A window the visitor has moved, resized, snapped or
 * tiled keeps that rect (kept on screen if the stage shrinks); one they have
 * not touched opens where `windowRect` places it: the first against the right
 * edge, the second tiled beside it, later ones cascading. The stage is
 * measured with a ResizeObserver so those rects follow the viewport. Touch
 * devices get exactly one full-screen window: the active one.
 *
 * Pointer events: every layer here is `pointer-events: none` and only the
 * window frame itself re-enables them. A full-area `auto` wrapper used to
 * swallow every click, which is what made the icon field dead once a window
 * was open.
 */
export function WindowManager({ windows, activeId, actions, touch, renderBody, origins = {} }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ w: 1280, h: 760 });

  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) setStage({ w: box.width, h: box.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const visible = touch ? windows.filter((w) => w.winId === activeId && !w.minimized) : windows;

  return (
    // Window plane: starts under the top bar so a fresh window can never open
    // behind it, and sits above the rack but below the dock.
    <div ref={stageRef} className="os-stage">
      <AnimatePresence>
        {visible.map((win) => {
          if (win.minimized) return null;
          // This layer spans the whole stage, so scaling it about the icon's
          // point draws the window out of that icon. Only transform and
          // opacity move; a reduced-motion setting drops the scale.
          const origin = origins[`${win.appId}:${win.instanceKey}`];
          return (
            <div
              key={win.winId}
              style={{ zIndex: 1 + win.z }}
              className="pointer-events-none absolute inset-0"
            >
              <motion.div
                initial={origin ? { opacity: 0, scale: 0.14 } : { opacity: 0, scale: 0.97, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={origin ? { opacity: 0, scale: 0.14 } : { opacity: 0, scale: 0.97, y: 8 }}
                transition={
                  origin
                    ? { duration: 0.34, ease: ZOOM, opacity: { duration: 0.2 } }
                    : { duration: 0.16, ease: EASE }
                }
                style={origin ? { transformOrigin: `${origin.x}px ${origin.y}px` } : undefined}
                className="pointer-events-none absolute inset-0"
              >
                <WindowFrame
                  win={win}
                  active={win.winId === activeId}
                  rect={
                    win.rect
                      ? clampRect(win.rect, stage.w, stage.h)
                      : windowRect(win.cascade, win.size, stage.w, stage.h)
                  }
                  stage={stage}
                  maximized={win.maximized}
                  touch={touch}
                  onFocus={() => actions.focus(win.winId)}
                  onMin={() => actions.minimize(win.winId)}
                  onMax={() => actions.toggleMax(win.winId)}
                  onClose={() => actions.close(win.winId)}
                  onRect={(rect) => actions.setRect(win.winId, rect)}
                >
                  {renderBody(win)}
                </WindowFrame>
              </motion.div>
            </div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
