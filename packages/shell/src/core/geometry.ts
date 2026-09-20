import type { Rect, WindowSize } from "./types";

const EDGE = 16;
/** Room kept free under a window for the dock. */
const DOCK_CLEARANCE = 76;
const GAP = 16;
const STEP = 28;

function clampRange(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/**
 * Where a window opens, given how many were open before it (`slot`, which is
 * the reducer's `cascade`) and the size of the stage.
 *
 * The first window sits against the right edge, so the trays on the left stay
 * readable. The second takes the left side beside it when both fit, which
 * tiles two windows instead of stacking them. Later windows cascade from
 * whichever side they land on. A stage too narrow for two cascades everything
 * from the right. No rect ever leaves the stage or runs under the dock.
 */
export function windowRect(slot: number, size: WindowSize, stageW: number, stageH: number): Rect {
  const width = Math.max(260, Math.min(size.w, stageW - EDGE * 2));
  const height = Math.max(200, Math.min(size.h, stageH - EDGE - DOCK_CLEARANCE));
  const twoFit = stageW >= EDGE * 2 + GAP + width * 2;
  const onLeft = twoFit && slot % 2 === 1;
  const depth = (twoFit ? Math.floor(slot / 2) : slot) * STEP;
  const left = onLeft ? EDGE + depth : stageW - EDGE - width - depth;
  const top = EDGE + depth;
  return {
    left: clampRange(left, EDGE, Math.max(EDGE, stageW - EDGE - width)),
    top: clampRange(top, EDGE, Math.max(EDGE, stageH - DOCK_CLEARANCE - height)),
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
