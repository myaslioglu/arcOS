import { afterEach, describe, expect, it, vi } from "vitest";

const KEY = "arcos-theme";

/** Just enough of a browser for the theme runtime: storage, the dark-scheme query, window events and <html>. */
function fakeBrowser(opts: { stored?: string; systemDark?: boolean; storage?: "ok" | "throws" } = {}) {
  const store = new Map<string, string>(opts.stored === undefined ? [] : [[KEY, opts.stored]]);
  const media = Object.assign(new EventTarget(), { matches: opts.systemDark ?? false });
  const win = Object.assign(new EventTarget(), { matchMedia: () => media });
  if (opts.storage === "throws") {
    // Blocked site data: reading window.localStorage itself throws.
    Object.defineProperty(win, "localStorage", {
      get() {
        throw new Error("SecurityError: the operation is insecure");
      },
    });
  } else {
    Object.assign(win, {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k),
      },
    });
  }
  const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", { documentElement: root });
  return {
    store,
    root,
    win,
    setSystemDark(dark: boolean) {
      media.matches = dark;
      media.dispatchEvent(new Event("change"));
    },
    /** What another tab's write looks like from here; a null key is that tab clearing storage. */
    otherTabWrites(value: string | null, key: string | null = KEY) {
      if (key === null) store.clear();
      else if (key === KEY && value === null) store.delete(KEY);
      else if (key === KEY && value !== null) store.set(KEY, value);
      win.dispatchEvent(Object.assign(new Event("storage"), { key }));
    },
  };
}

/** A fresh copy of the runtime, so a choice kept for "this page" never leaks between tests. */
async function runtime() {
  vi.resetModules();
  return import("../theme");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readThemePreference", () => {
  it("reads an explicit choice, and anything else as following the system", async () => {
    fakeBrowser({ stored: "dark" });
    expect((await runtime()).readThemePreference()).toBe("dark");
    fakeBrowser({ stored: "sepia" });
    expect((await runtime()).readThemePreference()).toBe("system");
    fakeBrowser();
    expect((await runtime()).readThemePreference()).toBe("system");
    fakeBrowser({ storage: "throws" });
    expect((await runtime()).readThemePreference()).toBe("system");
  });
});

describe("setThemePreference", () => {
  it("keeps an explicit choice and puts it on <html>", async () => {
    const b = fakeBrowser({ systemDark: false });
    const t = await runtime();
    t.setThemePreference("dark");
    expect(b.store.get(KEY)).toBe("dark");
    expect(b.root.dataset.theme).toBe("dark");
    expect(b.root.style.colorScheme).toBe("dark");
    expect(t.getThemeSnapshot()).toEqual({ preference: "dark", resolved: "dark" });
  });

  it("removes the key for the system preference and follows the system", async () => {
    const b = fakeBrowser({ stored: "light", systemDark: true });
    const t = await runtime();
    t.setThemePreference("system");
    expect(b.store.has(KEY)).toBe(false);
    expect(b.root.dataset.theme).toBe("dark");
    expect(t.getThemeSnapshot()).toEqual({ preference: "system", resolved: "dark" });
  });

  it("keeps a choice for this page when storage refuses it", async () => {
    const b = fakeBrowser({ storage: "throws", systemDark: false });
    const t = await runtime();
    t.setThemePreference("dark");
    expect(b.root.dataset.theme).toBe("dark");
    expect(t.getThemeSnapshot()).toEqual({ preference: "dark", resolved: "dark" });
    t.setThemePreference("system");
    expect(t.getThemeSnapshot()).toEqual({ preference: "system", resolved: "light" });
  });

  it("tells the rest of the page", async () => {
    const b = fakeBrowser();
    const t = await runtime();
    const heard = vi.fn();
    b.win.addEventListener(t.THEME_CHANGE_EVENT, heard);
    t.setThemePreference("dark");
    expect(t.THEME_CHANGE_EVENT).toBe("arcos-themechange");
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe("toggleTheme", () => {
  it("sets the opposite of the theme on screen as an explicit choice", async () => {
    const b = fakeBrowser({ systemDark: true });
    const t = await runtime();
    expect(t.getThemeSnapshot()).toEqual({ preference: "system", resolved: "dark" });
    t.toggleTheme();
    expect(b.store.get(KEY)).toBe("light");
    expect(t.getThemeSnapshot()).toEqual({ preference: "light", resolved: "light" });
    t.toggleTheme();
    expect(b.store.get(KEY)).toBe("dark");
    expect(b.root.dataset.theme).toBe("dark");
  });
});

describe("getThemeSnapshot", () => {
  it("returns the same object until something changes", async () => {
    fakeBrowser();
    const t = await runtime();
    const first = t.getThemeSnapshot();
    expect(t.getThemeSnapshot()).toBe(first);
    t.setThemePreference("dark");
    expect(t.getThemeSnapshot()).not.toBe(first);
  });

  it("follows the system setting only while the preference is system", async () => {
    const b = fakeBrowser({ systemDark: false });
    const t = await runtime();
    b.setSystemDark(true);
    expect(t.getThemeSnapshot().resolved).toBe("dark");
    t.setThemePreference("light");
    b.setSystemDark(false);
    b.setSystemDark(true);
    expect(t.getThemeSnapshot().resolved).toBe("light");
  });
});

describe("subscribeTheme", () => {
  it("hears this tab, other tabs and the system setting, until unsubscribed", async () => {
    const b = fakeBrowser({ systemDark: false });
    const t = await runtime();
    const onChange = vi.fn();
    const off = t.subscribeTheme(onChange);

    t.setThemePreference("dark");
    expect(onChange).toHaveBeenCalledTimes(1);

    b.otherTabWrites("light");
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(t.getThemeSnapshot().preference).toBe("light");

    b.otherTabWrites("dark", "some-other-key");
    expect(onChange).toHaveBeenCalledTimes(2);

    // Another tab clearing storage altogether.
    b.otherTabWrites(null, null);
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(t.getThemeSnapshot().preference).toBe("system");

    b.setSystemDark(true);
    expect(onChange).toHaveBeenCalledTimes(4);

    off();
    t.setThemePreference("light");
    b.otherTabWrites("dark");
    b.setSystemDark(false);
    expect(onChange).toHaveBeenCalledTimes(4);
  });
});
