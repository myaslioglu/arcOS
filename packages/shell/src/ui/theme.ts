"use client";

import { useLayoutEffect, useSyncExternalStore } from "react";
import {
  DARK_SCHEME_QUERY,
  THEME_STORAGE_KEY,
  parseStoredTheme,
  resolveTheme,
  type ThemeChoice,
  type ThemePreference,
} from "../core";

/** Fired on window whenever this tab changes the theme, so every control that shows it re-reads. */
export const THEME_CHANGE_EVENT = "arcos-themechange";

export type ThemeState = { preference: ThemePreference; resolved: ThemeChoice };

/** What the server renders: the state <html data-theme="light"> goes out in. */
const SERVER_STATE: ThemeState = { preference: "system", resolved: "light" };

/** A choice storage refused to keep (a private window, blocked site data). It lasts for this page. */
let unsaved: ThemePreference | null = null;
/** The last snapshot handed out, so an unchanged theme is the same object (useSyncExternalStore needs that). */
let snapshot: ThemeState = SERVER_STATE;
let darkQuery: MediaQueryList | null = null;

function darkScheme(): MediaQueryList {
  darkQuery ??= window.matchMedia(DARK_SCHEME_QUERY);
  return darkQuery;
}

export function readThemePreference(): ThemePreference {
  if (unsaved) return unsaved;
  try {
    return parseStoredTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

export function getThemeSnapshot(): ThemeState {
  const preference = readThemePreference();
  const resolved = resolveTheme(preference, darkScheme().matches);
  if (preference !== snapshot.preference || resolved !== snapshot.resolved) snapshot = { preference, resolved };
  return snapshot;
}

function applyTheme(theme: ThemeChoice): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

/** Keeps the choice ("system" removes it), puts the resolved theme on <html> and tells the page. */
export function setThemePreference(preference: ThemePreference): void {
  try {
    if (preference === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, preference);
    unsaved = null;
  } catch {
    unsaved = preference;
  }
  applyTheme(getThemeSnapshot().resolved);
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}

/** The menu bar's switch: the opposite of the theme on screen, kept as an explicit choice. */
export function toggleTheme(): void {
  setThemePreference(getThemeSnapshot().resolved === "dark" ? "light" : "dark");
}

/**
 * Calls `onChange` when this tab changes the theme, when another tab does (the `storage` event),
 * and when the system setting flips, which moves the theme only while the preference is "system".
 */
export function subscribeTheme(onChange: () => void): () => void {
  const media = darkScheme();
  const onStorage = (e: StorageEvent) => {
    // A null key is another tab clearing storage altogether.
    if (e.key !== THEME_STORAGE_KEY && e.key !== null) return;
    unsaved = null;
    onChange();
  };
  media.addEventListener("change", onChange);
  window.addEventListener("storage", onStorage);
  window.addEventListener(THEME_CHANGE_EVENT, onChange);
  return () => {
    media.removeEventListener("change", onChange);
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(THEME_CHANGE_EVENT, onChange);
  };
}

const serverSnapshot = () => SERVER_STATE;

/** The visitor's theme preference and the theme it resolves to. `{ preference: "system", resolved: "light" }` on the server. */
export function useTheme(): ThemeState {
  const theme = useSyncExternalStore(subscribeTheme, getThemeSnapshot, serverSnapshot);
  // Keeps <html> on the resolved theme after another tab or the system setting changes it, and on
  // mount, because React's development remount resets <html> to the attributes the layout renders
  // (see node_modules/next/dist/docs, "Preventing flash before hydration"). It reads the store rather
  // than `theme`: while hydrating, `theme` is still the server's snapshot.
  useLayoutEffect(() => {
    applyTheme(getThemeSnapshot().resolved);
  }, [theme.resolved]);
  return theme;
}

/** Mounted once in the root layout, so every route, not only the desktop, stays on the visitor's theme. */
export function ThemeSync(): null {
  useTheme();
  return null;
}
