"use client";

import { useMemo, useReducer } from "react";
import {
  initialWindowState,
  openActionFor,
  windowReducer,
  type Rect,
  type Registry,
} from "../../core";

export type WindowActions = {
  /** Returns false when the app is unknown or not openable yet. */
  open: (appId: string, params?: Record<string, string>) => boolean;
  setTitle: (winId: string, title: string) => void;
  focus: (winId: string) => void;
  minimize: (winId: string) => void;
  toggleMax: (winId: string) => void;
  close: (winId: string) => void;
  closeAll: () => void;
  setRect: (winId: string, rect: Rect) => void;
  tile: (stageW: number, stageH: number) => void;
  minimizeAll: () => void;
};

export function useWindowManager(registry: Registry) {
  const [state, dispatch] = useReducer(windowReducer, undefined, initialWindowState);

  const actions = useMemo<WindowActions>(
    () => ({
      open: (appId, params = {}) => {
        const action = openActionFor(registry, appId, params);
        if (!action) return false;
        dispatch(action);
        return true;
      },
      setTitle: (winId, title) => dispatch({ type: "set-title", winId, title }),
      focus: (winId) => dispatch({ type: "focus", winId }),
      minimize: (winId) => dispatch({ type: "minimize", winId }),
      toggleMax: (winId) => dispatch({ type: "toggle-max", winId }),
      close: (winId) => dispatch({ type: "close", winId }),
      closeAll: () => dispatch({ type: "close-all" }),
      setRect: (winId, rect) => dispatch({ type: "set-rect", winId, rect }),
      tile: (stageW, stageH) => dispatch({ type: "tile", stageW, stageH }),
      minimizeAll: () => dispatch({ type: "minimize-all" }),
    }),
    [registry],
  );

  return { state, actions };
}
