"use client";

import { createContext, useContext } from "react";

export type Tone = "info" | "ok" | "warn";

/** What an app inside a window may ask of the desktop around it. */
export type DesktopApi = {
  notify: (text: string, tone?: Tone, ms?: number) => void;
  open: (appId: string, params?: Record<string, string>, from?: HTMLElement) => boolean;
  close: (winId: string) => void;
  setTitle: (winId: string, title: string) => void;
};

const DesktopContext = createContext<DesktopApi>({
  notify: () => {},
  open: () => false,
  close: () => {},
  setTitle: () => {},
});

export const DesktopProvider = DesktopContext.Provider;

export function useDesktop(): DesktopApi {
  return useContext(DesktopContext);
}
