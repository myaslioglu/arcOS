export type Rect = { left: number; top: number; width: number; height: number };
export type WindowSize = { w: number; h: number };

export type DesktopWindow = {
  winId: string;
  appId: string;
  /** Tells windows of one app apart (one Inspector per token). "" for a singleton. */
  instanceKey: string;
  params: Record<string, string>;
  title: string;
  /** Preferred size from the manifest, before the stage clamps it. */
  size: WindowSize;
  /** The app paints edge to edge and scrolls itself. */
  flush: boolean;
  z: number;
  minimized: boolean;
  maximized: boolean;
  cascade: number;
  rect: Rect | null;
};

export type WindowState = {
  windows: DesktopWindow[];
  activeId: string | null;
  seq: number;
  zTop: number;
};

export type WindowAction =
  | {
      type: "open";
      appId: string;
      instanceKey: string;
      params: Record<string, string>;
      title: string;
      size: WindowSize;
      flush: boolean;
    }
  | { type: "set-title"; winId: string; title: string }
  | { type: "focus"; winId: string }
  | { type: "minimize"; winId: string }
  | { type: "toggle-max"; winId: string }
  | { type: "close"; winId: string }
  | { type: "close-all" }
  | { type: "set-rect"; winId: string; rect: Rect }
  | { type: "tile"; stageW: number; stageH: number }
  | { type: "minimize-all" };
