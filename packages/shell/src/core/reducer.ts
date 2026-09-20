import { tileRects } from "./geometry";
import type { DesktopWindow, WindowAction, WindowState } from "./types";

export function initialWindowState(): WindowState {
  return { windows: [], activeId: null, seq: 0, zTop: 0 };
}

/** Topmost non-minimized window, used when the active one goes away. */
function topVisible(windows: DesktopWindow[]): DesktopWindow | undefined {
  let best: DesktopWindow | undefined;
  for (const w of windows) {
    if (w.minimized) continue;
    if (!best || w.z > best.z) best = w;
  }
  return best;
}

/**
 * Pure window manager. Language-free on purpose: callers resolve `title`
 * via `desktopItemTitle` before dispatching `open`, so this reducer is
 * trivially unit-testable and safe to run anywhere.
 *
 * - `open` de-dupes on appId+instanceKey: an existing window is focused, restored
 *   and lifted instead of opening a second copy.
 * - `focus` also restores (dock clicks on a minimized window land here).
 * - Closing or minimizing the active window falls back to the topmost
 *   visible window, or null when none remains.
 */
export function windowReducer(state: WindowState, action: WindowAction): WindowState {
  switch (action.type) {
    case "open": {
      const existing = state.windows.find(
        (w) => w.appId === action.appId && w.instanceKey === action.instanceKey,
      );
      if (existing) {
        const zTop = state.zTop + 1;
        const hasParams = Object.keys(action.params).length > 0;
        return {
          ...state,
          zTop,
          activeId: existing.winId,
          windows: state.windows.map((w) =>
            w.winId === existing.winId
              ? { ...w, z: zTop, minimized: false, params: hasParams ? action.params : w.params }
              : w,
          ),
        };
      }
      const seq = state.seq + 1;
      const zTop = state.zTop + 1;
      const win: DesktopWindow = {
        winId: `w-${seq}`,
        appId: action.appId,
        instanceKey: action.instanceKey,
        params: action.params,
        title: action.title,
        size: action.size,
        flush: action.flush,
        z: zTop,
        minimized: false,
        maximized: false,
        cascade: state.windows.length % 8,
        rect: null,
      };
      return { windows: [...state.windows, win], activeId: win.winId, seq, zTop };
    }
    case "set-title": {
      if (!state.windows.some((w) => w.winId === action.winId)) return state;
      return {
        ...state,
        windows: state.windows.map((w) => (w.winId === action.winId ? { ...w, title: action.title } : w)),
      };
    }
    case "focus": {
      const target = state.windows.find((w) => w.winId === action.winId);
      if (!target) return state;
      if (target.winId === state.activeId && !target.minimized) return state;
      const zTop = state.zTop + 1;
      return {
        ...state,
        zTop,
        activeId: target.winId,
        windows: state.windows.map((w) =>
          w.winId === target.winId ? { ...w, z: zTop, minimized: false } : w,
        ),
      };
    }
    case "minimize": {
      if (!state.windows.some((w) => w.winId === action.winId)) return state;
      const windows = state.windows.map((w) =>
        w.winId === action.winId ? { ...w, minimized: true } : w,
      );
      const activeId =
        state.activeId === action.winId ? (topVisible(windows)?.winId ?? null) : state.activeId;
      return { ...state, windows, activeId };
    }
    case "toggle-max": {
      const target = state.windows.find((w) => w.winId === action.winId);
      if (!target) return state;
      const zTop = state.zTop + 1;
      return {
        ...state,
        zTop,
        activeId: target.winId,
        windows: state.windows.map((w) =>
          w.winId === target.winId
            ? { ...w, maximized: !w.maximized, minimized: false, z: zTop }
            : w,
        ),
      };
    }
    case "close": {
      if (!state.windows.some((w) => w.winId === action.winId)) return state;
      const windows = state.windows.filter((w) => w.winId !== action.winId);
      const activeId =
        state.activeId === action.winId ? (topVisible(windows)?.winId ?? null) : state.activeId;
      return { ...state, windows, activeId };
    }
    case "close-all":
      return { ...state, windows: [], activeId: null };
    case "set-rect": {
      if (!state.windows.some((w) => w.winId === action.winId)) return state;
      return {
        ...state,
        windows: state.windows.map((w) =>
          w.winId === action.winId ? { ...w, rect: action.rect, maximized: false } : w,
        ),
      };
    }
    case "tile": {
      // Bottom of the stack first, so the focused window keeps the last cell.
      const visible = state.windows.filter((w) => !w.minimized).sort((a, b) => a.z - b.z);
      if (visible.length === 0) return state;
      const rects = tileRects(visible.length, action.stageW, action.stageH);
      const cell = new Map(visible.map((w, i) => [w.winId, rects[i]]));
      return {
        ...state,
        windows: state.windows.map((w) => {
          const rect = cell.get(w.winId);
          return rect ? { ...w, rect, maximized: false } : w;
        }),
      };
    }
    case "minimize-all":
      if (state.windows.every((w) => w.minimized)) return state;
      return {
        ...state,
        activeId: null,
        windows: state.windows.map((w) => ({ ...w, minimized: true })),
      };
  }
}
