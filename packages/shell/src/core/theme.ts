/**
 * The theme rules, shared by the boot script (which runs in <head> before the first paint) and the
 * client runtime (ui/theme.ts). A visitor either chose light or dark, or made no choice, in which
 * case the page follows their system setting.
 */

/** Where the choice lives in localStorage. No key means "follow the system". */
export const THEME_STORAGE_KEY = "arcos-theme";
export const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

export type ThemeChoice = "light" | "dark";
export type ThemePreference = ThemeChoice | "system";

/** Only "light" and "dark" are choices; anything else, a missing value included, follows the system. */
export function parseStoredTheme(raw: string | null): ThemePreference {
  return raw === "light" || raw === "dark" ? raw : "system";
}

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ThemeChoice {
  if (preference !== "system") return preference;
  return systemPrefersDark ? "dark" : "light";
}

/**
 * The same rules as `parseStoredTheme` and `resolveTheme`, as a script the root layout inlines in
 * <head>, so <html> carries the visitor's theme before anything is painted. Storage that throws (a
 * private window, blocked site data) counts as no choice; if the system can't be asked either, the
 * page stays light, like the server render.
 */
export const THEME_BOOT_SCRIPT =
  `(function(){var t=null;` +
  `try{var s=window.localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(s==="light"||s==="dark")t=s}catch(e){}` +
  `if(!t){try{t=window.matchMedia(${JSON.stringify(DARK_SCHEME_QUERY)}).matches?"dark":"light"}catch(e){t="light"}}` +
  `var r=document.documentElement;r.dataset.theme=t;r.style.colorScheme=t})()`;
