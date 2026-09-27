import { describe, expect, it } from "vitest";
import {
  DARK_SCHEME_QUERY,
  THEME_BOOT_SCRIPT,
  THEME_STORAGE_KEY,
  parseStoredTheme,
  resolveTheme,
  type ThemeChoice,
} from "../theme";

describe("parseStoredTheme", () => {
  it("keeps an explicit light or dark choice", () => {
    expect(parseStoredTheme("light")).toBe("light");
    expect(parseStoredTheme("dark")).toBe("dark");
  });

  it("reads anything else, a missing value included, as following the system", () => {
    for (const raw of [null, "", "system", "Dark", " dark", '"dark"', "sepia", "undefined"]) {
      expect(parseStoredTheme(raw)).toBe("system");
    }
  });
});

describe("resolveTheme", () => {
  it("keeps an explicit choice whatever the system prefers", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("follows the system for the system preference", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

type Storage = { getItem: (key: string) => string | null } | "throws" | "getItem throws";

/** Runs the boot script the way the browser does, against stand-ins for the three globals it touches. */
function boot(storage: Storage, systemDark: boolean) {
  const asked: { keys: string[]; queries: string[] } = { keys: [], queries: [] };
  const win: Record<string, unknown> = {
    matchMedia: (query: string) => {
      asked.queries.push(query);
      return { matches: systemDark };
    },
  };
  if (storage === "throws") {
    // What a browser does when site data is blocked: reading the property itself throws.
    Object.defineProperty(win, "localStorage", {
      get() {
        throw new Error("SecurityError: the operation is insecure");
      },
    });
  } else if (storage === "getItem throws") {
    win.localStorage = {
      getItem() {
        throw new Error("SecurityError: the operation is insecure");
      },
    };
  } else {
    win.localStorage = {
      getItem: (key: string) => {
        asked.keys.push(key);
        return storage.getItem(key);
      },
    };
  }
  const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
  new Function("window", "document", THEME_BOOT_SCRIPT)(win, { documentElement: root });
  return { theme: root.dataset.theme, colorScheme: root.style.colorScheme, asked };
}

const stored = (value: string | null) => ({ getItem: (key: string) => (key === THEME_STORAGE_KEY ? value : null) });

describe("THEME_BOOT_SCRIPT", () => {
  const cases: { name: string; storage: Storage; systemDark: boolean; raw: string | null; want: ThemeChoice }[] = [
    { name: "stored light", storage: stored("light"), systemDark: true, raw: "light", want: "light" },
    { name: "stored dark", storage: stored("dark"), systemDark: false, raw: "dark", want: "dark" },
    { name: "missing, with a dark system", storage: stored(null), systemDark: true, raw: null, want: "dark" },
    { name: "missing, with a light system", storage: stored(null), systemDark: false, raw: null, want: "light" },
    { name: "a junk value", storage: stored("sepia"), systemDark: true, raw: "sepia", want: "dark" },
    { name: "localStorage throwing", storage: "throws", systemDark: true, raw: null, want: "dark" },
    { name: "getItem throwing", storage: "getItem throws", systemDark: false, raw: null, want: "light" },
  ];

  for (const c of cases) {
    it(`applies ${c.want} for ${c.name}, as the shared rules do`, () => {
      const { theme, colorScheme } = boot(c.storage, c.systemDark);
      expect(theme).toBe(c.want);
      expect(colorScheme).toBe(c.want);
      expect(theme).toBe(resolveTheme(parseStoredTheme(c.raw), c.systemDark));
    });
  }

  it("reads the shared storage key and asks the shared media query", () => {
    const { asked } = boot(stored(null), false);
    expect(asked.keys).toEqual([THEME_STORAGE_KEY]);
    expect(asked.queries).toEqual([DARK_SCHEME_QUERY]);
  });

  it("stays light when neither storage nor matchMedia can answer", () => {
    const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
    new Function("window", "document", THEME_BOOT_SCRIPT)({}, { documentElement: root });
    expect(root.dataset.theme).toBe("light");
    expect(root.style.colorScheme).toBe("light");
  });

  it("uses the key the rest of the shell uses", () => {
    expect(THEME_STORAGE_KEY).toBe("arcos-theme");
    expect(THEME_BOOT_SCRIPT).toContain(JSON.stringify(THEME_STORAGE_KEY));
  });
});
