"use client";

import { useSyncExternalStore } from "react";
import { DEFAULT_VIEW, VIEW_STORAGE_KEY, parseStoredView, type DesktopView } from "../core";

/** Fired on window whenever this tab changes the view, so the desk, the menu and the touch home re-read it. */
export const VIEW_CHANGE_EVENT = "arcos-viewchange";

/** A choice storage refused to keep (a private window, blocked site data). It lasts for this page. */
let unsaved: DesktopView | null = null;

/** Every access to storage is in a try/catch: storage that throws reads as the default. */
export function readDesktopView(): DesktopView {
  if (unsaved) return unsaved;
  try {
    return parseStoredView(window.localStorage.getItem(VIEW_STORAGE_KEY));
  } catch {
    return DEFAULT_VIEW;
  }
}

/** Keeps the choice and tells the page. */
export function setDesktopView(view: DesktopView): void {
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, view);
    unsaved = null;
  } catch {
    unsaved = view;
  }
  window.dispatchEvent(new Event(VIEW_CHANGE_EVENT));
}

/** Calls `onChange` when this tab changes the view, and when another tab does (the `storage` event). */
export function subscribeDesktopView(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    // A null key is another tab clearing storage altogether.
    if (e.key !== VIEW_STORAGE_KEY && e.key !== null) return;
    unsaved = null;
    onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(VIEW_CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(VIEW_CHANGE_EVENT, onChange);
  };
}

const serverView = (): DesktopView => DEFAULT_VIEW;

/** The desktop's view. The server renders the default; a stored choice takes over after hydration. */
export function useDesktopView(): DesktopView {
  return useSyncExternalStore(subscribeDesktopView, readDesktopView, serverView);
}
