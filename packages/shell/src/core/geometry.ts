import type { Rect, WindowSize } from "./types";

const EDGE = 16;
/** Room kept free under a window for the dock. */
const DOCK_CLEARANCE = 76;
/** How far each new window sits down and right of the one before. */
const STEP = 28;
/** Where the first window sits in the free vertical room: 0.5 is the middle, less is higher. */
const RISE = 0.4;
/**
 * The height of a typical window. Windows up to this tall share one top line,
 * the one a window this tall would get, so their title bars step down evenly
 * whatever their sizes; a taller window rises above that line to fit.
 */
const TYPICAL_H = 480;

function clampRange(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/**
 * Where a window opens, given how many were open before it (`slot`, which is
 * the reducer's `cascade`) and the size of the stage, the way a desktop OS
 * does it: around the middle, each new window overlapping the last.
 *
 * Slot 0 is centred horizontally and sits a little above the middle of the
 * room between the top margin and the dock (its top on a line shared by every
 * window up to TYPICAL_H tall). Each later slot moves one STEP down and right,
 * so the title bars step down evenly even when the windows differ in size.
 * When the next step would push the window under the dock, the cascade starts
 * a new column: back at the first window's top, one STEP further right than
 * the column before, so on a stage with room every slot lands somewhere
 * distinct.
 *
 * A stage with no room to spare in a direction (a phone, a window as large as
 * the stage) simply holds that coordinate. No rect ever leaves the stage or
 * runs under the dock; windows may cover the desktop's folders, as they do on
 * any desktop, and can be dragged off them.
 */
export function windowRect(slot: number, size: WindowSize, stageW: number, stageH: number): Rect {
  const width = Math.max(260, Math.min(size.w, stageW - EDGE * 2));
  const height = Math.max(200, Math.min(size.h, stageH - EDGE - DOCK_CLEARANCE));
  const maxLeft = Math.max(EDGE, stageW - EDGE - width);
  const maxTop = Math.max(EDGE, stageH - DOCK_CLEARANCE - height);
  const baseLeft = EDGE + Math.round((maxLeft - EDGE) / 2);
  const room = stageH - DOCK_CLEARANCE - EDGE;
  const sharedTop = EDGE + Math.round(Math.max(0, room - TYPICAL_H) * RISE);
  const baseTop = Math.min(sharedTop, EDGE + Math.round((maxTop - EDGE) * RISE));
  // How many windows one column holds before the next would reach the dock.
  const perColumn = 1 + Math.floor((maxTop - baseTop) / STEP);
  const row = slot % perColumn;
  const column = Math.floor(slot / perColumn);
  return {
    left: clampRange(baseLeft + (row + column) * STEP, EDGE, maxLeft),
    top: clampRange(baseTop + row * STEP, EDGE, maxTop),
    width,
    height,
  };
}

/** The smallest a window can be resized to. */
export const MIN_WINDOW = { w: 320, h: 220 } as const;

/**
 * A remembered rect, kept usable after the stage shrinks: never smaller than
 * the minimum, never larger than the stage, never so far out that the title
 * bar cannot be grabbed again.
 */
export function clampRect(r: Rect, stageW: number, stageH: number): Rect {
  const width = clampRange(r.width, MIN_WINDOW.w, Math.max(MIN_WINDOW.w, stageW - 16));
  const height = clampRange(
    r.height,
    MIN_WINDOW.h,
    Math.max(MIN_WINDOW.h, stageH - DOCK_CLEARANCE - 8),
  );
  return {
    left: clampRange(r.left, 0, Math.max(0, stageW - 120)),
    top: clampRange(r.top, 0, Math.max(0, stageH - 48)),
    width,
    height,
  };
}

export type SnapZone = "left" | "right" | "top";
const SNAP_EDGE = 12;

/** Which edge a dragged title bar is pressed against, in stage coordinates. */
export function snapZone(x: number, y: number, stageW: number): SnapZone | null {
  if (y <= SNAP_EDGE / 2) return "top";
  if (x <= SNAP_EDGE) return "left";
  if (x >= stageW - SNAP_EDGE) return "right";
  return null;
}

/** The half of the stage (or all of it) a snapped window fills, clear of the dock. */
export function snapRect(zone: SnapZone, stageW: number, stageH: number): Rect {
  const m = 8;
  const height = Math.max(MIN_WINDOW.h, stageH - m - DOCK_CLEARANCE);
  if (zone === "top") return { left: m, top: m, width: Math.max(MIN_WINDOW.w, stageW - m * 2), height };
  const width = Math.max(MIN_WINDOW.w, Math.floor((stageW - m * 3) / 2));
  return { left: zone === "left" ? m : Math.max(m, stageW - m - width), top: m, width, height };
}

/**
 * Tiles n windows over the stage: as square a grid as fits, filled row by
 * row, the last row's windows sharing its full width.
 */
export function tileRects(n: number, stageW: number, stageH: number): Rect[] {
  if (n <= 0) return [];
  const m = 8;
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const areaW = stageW - m * 2;
  const areaH = Math.max(MIN_WINDOW.h, stageH - m - DOCK_CLEARANCE);
  const cellH = Math.floor((areaH - m * (rows - 1)) / rows);
  const rects: Rect[] = [];
  for (let r = 0; r < rows; r++) {
    const inRow = r === rows - 1 ? n - cols * (rows - 1) : cols;
    const cellW = Math.floor((areaW - m * (inRow - 1)) / inRow);
    for (let c = 0; c < inRow; c++) {
      rects.push({ left: m + c * (cellW + m), top: m + r * (cellH + m), width: cellW, height: cellH });
    }
  }
  return rects;
}
