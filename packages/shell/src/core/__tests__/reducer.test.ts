import { describe, expect, it } from "vitest";
import { initialWindowState, windowReducer } from "../reducer";
import type { WindowAction } from "../types";

const open = (appId: string, instanceKey = "", params: Record<string, string> = {}): WindowAction => ({
  type: "open",
  appId,
  instanceKey,
  params,
  title: appId,
  size: { w: 400, h: 300 },
  flush: false,
});

describe("windowReducer — app instances", () => {
  it("opens one window per appId+instanceKey", () => {
    let s = windowReducer(initialWindowState(), open("inspector", "0xa"));
    s = windowReducer(s, open("inspector", "0xb"));
    s = windowReducer(s, open("inspector", "0xa"));
    expect(s.windows.map((w) => w.instanceKey)).toEqual(["0xa", "0xb"]);
    expect(s.activeId).toBe(s.windows[0]!.winId);
  });

  it("re-opening a singleton replaces its params and restores it", () => {
    let s = windowReducer(initialWindowState(), open("drop", "", { token: "0x1" }));
    const id = s.windows[0]!.winId;
    s = windowReducer(s, { type: "minimize", winId: id });
    s = windowReducer(s, open("drop", "", { token: "0x2" }));
    expect(s.windows).toHaveLength(1);
    expect(s.windows[0]!.params).toEqual({ token: "0x2" });
    expect(s.windows[0]!.minimized).toBe(false);
  });

  it("re-opening with no params keeps the old ones", () => {
    let s = windowReducer(initialWindowState(), open("drop", "", { token: "0x1" }));
    s = windowReducer(s, open("drop"));
    expect(s.windows[0]!.params).toEqual({ token: "0x1" });
  });

  it("set-title renames one window and ignores unknown ids", () => {
    let s = windowReducer(initialWindowState(), open("inspector", "0xa"));
    const id = s.windows[0]!.winId;
    s = windowReducer(s, { type: "set-title", winId: id, title: "Inspector — DUKE" });
    expect(s.windows[0]!.title).toBe("Inspector — DUKE");
    expect(windowReducer(s, { type: "set-title", winId: "w-99", title: "x" })).toBe(s);
  });
});

describe("windowReducer", () => {
  it("opens windows with rising z and cascade steps", () => {
    let s = initialWindowState();
    s = windowReducer(s, open("app-a"));
    s = windowReducer(s, open("app-b"));
    expect(s.windows).toHaveLength(2);
    expect(s.windows[0]!.winId).toBe("w-1");
    expect(s.windows[1]!.winId).toBe("w-2");
    expect(s.windows[1]!.z).toBeGreaterThan(s.windows[0]!.z);
    expect(s.windows[1]!.cascade).toBe(1);
    expect(s.activeId).toBe("w-2");
  });

  it("de-dupes open on appId+instanceKey: focuses, restores and lifts", () => {
    let s = initialWindowState();
    s = windowReducer(s, open("app-a"));
    s = windowReducer(s, open("app-b"));
    s = windowReducer(s, { type: "minimize", winId: "w-1" });
    const before = s.windows.length;
    s = windowReducer(s, open("app-a"));
    expect(s.windows).toHaveLength(before);
    expect(s.activeId).toBe("w-1");
    expect(s.windows.find((w) => w.winId === "w-1")?.minimized).toBe(false);
    expect(s.windows.find((w) => w.winId === "w-1")?.z).toBe(s.zTop);
  });

  it("focus restores a minimized window", () => {
    let s = windowReducer(initialWindowState(), open("app-a"));
    s = windowReducer(s, { type: "minimize", winId: "w-1" });
    s = windowReducer(s, { type: "focus", winId: "w-1" });
    expect(s.windows[0]!.minimized).toBe(false);
    expect(s.activeId).toBe("w-1");
  });

  it("minimizing the active window falls back to the topmost visible one", () => {
    let s = initialWindowState();
    s = windowReducer(s, open("app-a"));
    s = windowReducer(s, open("app-b"));
    s = windowReducer(s, { type: "minimize", winId: "w-2" });
    expect(s.activeId).toBe("w-1");
    s = windowReducer(s, { type: "minimize", winId: "w-1" });
    expect(s.activeId).toBeNull();
  });

  it("toggle-max flips and lifts; close falls back to the previous top", () => {
    let s = initialWindowState();
    s = windowReducer(s, open("app-a"));
    s = windowReducer(s, open("app-b"));
    s = windowReducer(s, { type: "toggle-max", winId: "w-1" });
    expect(s.windows.find((w) => w.winId === "w-1")?.maximized).toBe(true);
    expect(s.activeId).toBe("w-1");
    s = windowReducer(s, { type: "toggle-max", winId: "w-1" });
    expect(s.windows.find((w) => w.winId === "w-1")?.maximized).toBe(false);
    s = windowReducer(s, { type: "close", winId: "w-1" });
    expect(s.windows).toHaveLength(1);
    expect(s.activeId).toBe("w-2");
    s = windowReducer(s, { type: "close-all" });
    expect(s.windows).toHaveLength(0);
    expect(s.activeId).toBeNull();
  });

  it("ignores unknown winIds without changing state", () => {
    const s = windowReducer(initialWindowState(), open("app-a"));
    expect(windowReducer(s, { type: "focus", winId: "w-99" })).toBe(s);
    expect(windowReducer(s, { type: "close", winId: "w-99" })).toBe(s);
  });
});

describe("window geometry", () => {
  it("remembers a rect, and a remembered rect leaves maximized", () => {
    let s = windowReducer(initialWindowState(), open("app-a"));
    expect(s.windows[0]!.rect).toBeNull();
    s = windowReducer(s, { type: "toggle-max", winId: "w-1" });
    const rect = { left: 40, top: 30, width: 500, height: 400 };
    s = windowReducer(s, { type: "set-rect", winId: "w-1", rect });
    expect(s.windows[0]!.rect).toEqual(rect);
    expect(s.windows[0]!.maximized).toBe(false);
    expect(windowReducer(s, { type: "set-rect", winId: "w-9", rect })).toBe(s);
  });

  it("tiles the visible windows side by side and leaves minimized ones alone", () => {
    let s = initialWindowState();
    for (const id of ["app-a", "app-c", "app-d"]) s = windowReducer(s, open(id));
    s = windowReducer(s, { type: "minimize", winId: "w-2" });
    s = windowReducer(s, { type: "tile", stageW: 1440, stageH: 860 });
    const placed = s.windows.filter((w) => w.rect);
    expect(placed.map((w) => w.winId)).toEqual(["w-1", "w-3"]);
    const [a, b] = placed.map((w) => w.rect!);
    expect(a.left + a.width).toBeLessThanOrEqual(b.left);
    expect(s.windows.find((w) => w.winId === "w-2")?.rect).toBeNull();
  });

  it("minimizes everything at once", () => {
    let s = windowReducer(windowReducer(initialWindowState(), open("app-a")), open("app-c"));
    s = windowReducer(s, { type: "minimize-all" });
    expect(s.windows.every((w) => w.minimized)).toBe(true);
    expect(s.activeId).toBeNull();
    expect(windowReducer(s, { type: "minimize-all" })).toBe(s);
  });
});
