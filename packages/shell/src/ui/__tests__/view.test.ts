import { afterEach, describe, expect, it, vi } from "vitest";

const KEY = "arcos-view";

/** Just enough of a browser for the view store: storage and window events. */
function fakeBrowser(opts: { stored?: string; storage?: "ok" | "throws" } = {}) {
  const store = new Map<string, string>(opts.stored === undefined ? [] : [[KEY, opts.stored]]);
  const win = new EventTarget();
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
  vi.stubGlobal("window", win);
  return {
    store,
    win,
    /** What another tab's write looks like from here; a null key is that tab clearing storage. */
    otherTabWrites(value: string | null, key: string | null = KEY) {
      if (key === null) store.clear();
      else if (value === null) store.delete(key);
      else store.set(key, value);
      win.dispatchEvent(Object.assign(new Event("storage"), { key }));
    },
  };
}

/** A fresh copy of the store, so a choice kept for "this page" never leaks between tests. */
async function runtime() {
  vi.resetModules();
  return import("../view");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readDesktopView", () => {
  it("reads a stored choice, and anything else, blocked storage included, as folders", async () => {
    fakeBrowser({ stored: "trays" });
    expect((await runtime()).readDesktopView()).toBe("trays");
    fakeBrowser({ stored: "list" });
    expect((await runtime()).readDesktopView()).toBe("folders");
    fakeBrowser();
    expect((await runtime()).readDesktopView()).toBe("folders");
    fakeBrowser({ storage: "throws" });
    expect((await runtime()).readDesktopView()).toBe("folders");
  });
});

describe("setDesktopView", () => {
  it("keeps the choice in arcos-view", async () => {
    const b = fakeBrowser();
    const v = await runtime();
    v.setDesktopView("trays");
    expect(b.store.get(KEY)).toBe("trays");
    expect(v.readDesktopView()).toBe("trays");
  });

  it("keeps a choice for this page when storage refuses it", async () => {
    fakeBrowser({ storage: "throws" });
    const v = await runtime();
    v.setDesktopView("trays");
    expect(v.readDesktopView()).toBe("trays");
    v.setDesktopView("folders");
    expect(v.readDesktopView()).toBe("folders");
  });

  it("tells the rest of the page", async () => {
    const b = fakeBrowser();
    const v = await runtime();
    const heard = vi.fn();
    b.win.addEventListener(v.VIEW_CHANGE_EVENT, heard);
    v.setDesktopView("trays");
    expect(v.VIEW_CHANGE_EVENT).toBe("arcos-viewchange");
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe("subscribeDesktopView", () => {
  it("hears this tab and other tabs, until unsubscribed", async () => {
    const b = fakeBrowser();
    const v = await runtime();
    const onChange = vi.fn();
    const off = v.subscribeDesktopView(onChange);

    v.setDesktopView("trays");
    expect(onChange).toHaveBeenCalledTimes(1);

    b.otherTabWrites("folders");
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(v.readDesktopView()).toBe("folders");

    b.otherTabWrites("trays", "arcos-theme");
    expect(onChange).toHaveBeenCalledTimes(2);

    // Another tab clearing storage altogether.
    b.otherTabWrites(null, null);
    expect(onChange).toHaveBeenCalledTimes(3);

    off();
    v.setDesktopView("trays");
    b.otherTabWrites("folders");
    expect(onChange).toHaveBeenCalledTimes(3);
  });
});
