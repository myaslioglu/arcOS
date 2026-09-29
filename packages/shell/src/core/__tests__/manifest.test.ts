import { describe, expect, it } from "vitest";
import {
  CATEGORY_HUE,
  CATEGORY_ORDER,
  FOLDER_APP_ID,
  ROADMAP_APP_ID,
  appHue,
  buildRegistry,
  folderWindowSize,
  isCategory,
  openActionFor,
  windowLook,
  type AppManifest,
} from "../manifest";

const stub = (over: Partial<AppManifest>): AppManifest => ({
  id: "x",
  name: "X",
  blurb: "",
  icon: (() => null) as unknown as AppManifest["icon"],
  category: "system",
  window: { w: 400, h: 300 },
  load: async () => ({ default: () => null }),
  requiresWallet: false,
  release: "r0",
  ...over,
});

describe("buildRegistry", () => {
  it("indexes manifests by id and keeps order", () => {
    const r = buildRegistry([stub({ id: "a" }), stub({ id: "b" })]);
    expect(r.list.map((m) => m.id)).toEqual(["a", "b"]);
    expect(r.byId.get("b")?.id).toBe("b");
  });

  it("rejects duplicate ids", () => {
    expect(() => buildRegistry([stub({ id: "a" }), stub({ id: "a" })])).toThrow(/duplicate app id "a"/);
  });

  it("rejects an id the desktop keeps for its own windows", () => {
    for (const id of [FOLDER_APP_ID, ROADMAP_APP_ID]) {
      expect(() => buildRegistry([stub({ id })])).toThrow(`"${id}" is kept for the desktop's own windows`);
    }
  });
});

describe("openActionFor", () => {
  const registry = buildRegistry([
    stub({ id: "mint", name: "Mint", window: { w: 440, h: 560 } }),
    stub({
      id: "inspector",
      name: "Inspector",
      window: { w: 520, h: 640, flush: true },
      instanceKey: (p) => (p.token ?? "").toLowerCase(),
    }),
    stub({ id: "vault", name: "Vault", comingSoon: true, release: "r2", window: { w: 480, h: 420 } }),
  ]);

  it("returns null for an unknown app", () => {
    expect(openActionFor(registry, "nope", {})).toBeNull();
  });

  it("opens a singleton with an empty instance key", () => {
    expect(openActionFor(registry, "mint", {})).toEqual({
      type: "open",
      appId: "mint",
      instanceKey: "",
      params: {},
      title: "Mint",
      size: { w: 440, h: 560 },
      flush: false,
    });
  });

  it("derives the instance key from params", () => {
    const a = openActionFor(registry, "inspector", { token: "0xABC" });
    expect(a?.instanceKey).toBe("0xabc");
    expect(a?.flush).toBe(true);
  });

  it("opens a grey app as its small work in progress window, whatever the params", () => {
    expect(openActionFor(registry, "vault", { token: "0xabc" })).toEqual({
      type: "open",
      appId: "vault",
      instanceKey: "",
      params: {},
      title: "Vault",
      size: { w: 380, h: 300 },
      flush: false,
    });
  });

  it("opens the Roadmap as the desktop's own window", () => {
    expect(openActionFor(registry, ROADMAP_APP_ID, { x: "1" })).toEqual({
      type: "open",
      appId: "roadmap",
      instanceKey: "",
      params: {},
      title: "Roadmap",
      size: { w: 460, h: 420 },
      flush: false,
    });
  });
});

describe("folder windows", () => {
  const registry = buildRegistry([
    stub({ id: "inspector", category: "trust" }),
    stub({ id: "vault", category: "trust", comingSoon: true }),
    stub({ id: "mint", category: "create" }),
  ]);

  it("opens a folder window keyed by its category, titled and sized for its apps", () => {
    expect(openActionFor(registry, FOLDER_APP_ID, { group: "trust" })).toEqual({
      type: "open",
      appId: "folder",
      instanceKey: "trust",
      params: { group: "trust" },
      title: "Trust",
      size: { w: 380, h: 212 },
      flush: true,
    });
  });

  it("opens nothing for an unknown category, a missing one, or one without apps", () => {
    expect(openActionFor(registry, FOLDER_APP_ID, { group: "games" })).toBeNull();
    expect(openActionFor(registry, FOLDER_APP_ID, { group: "__proto__" })).toBeNull();
    expect(openActionFor(registry, FOLDER_APP_ID, {})).toBeNull();
    expect(openActionFor(registry, FOLDER_APP_ID, { group: "trade" })).toBeNull();
  });
});

describe("folderWindowSize", () => {
  it("fits every app without scrolling: up to four across, then rows, each row tall enough for a grey app's Soon tag", () => {
    expect(folderWindowSize(1)).toEqual({ w: 380, h: 212 });
    expect(folderWindowSize(2)).toEqual({ w: 380, h: 212 });
    expect(folderWindowSize(3)).toEqual({ w: 404, h: 212 });
    expect(folderWindowSize(4)).toEqual({ w: 520, h: 212 });
    expect(folderWindowSize(5)).toEqual({ w: 404, h: 314 });
    expect(folderWindowSize(7)).toEqual({ w: 520, h: 314 });
  });
});

describe("isCategory", () => {
  it("accepts the four categories and nothing else", () => {
    for (const c of CATEGORY_ORDER) expect(isCategory(c)).toBe(true);
    for (const v of ["", "System", "games", "__proto__", "constructor", null, 1]) expect(isCategory(v)).toBe(false);
  });
});

describe("windowLook", () => {
  const registry = buildRegistry([
    stub({ id: "inspector", category: "trust" }),
    stub({ id: "vault", category: "trust", comingSoon: true }),
  ]);

  it("gives a folder window its category's hue and the folder kind", () => {
    expect(windowLook(registry, { appId: FOLDER_APP_ID, instanceKey: "create" })).toEqual({
      hue: "var(--accent-3)",
      kind: "folder",
      app: null,
    });
  });

  it("gives an app's window its app's hue and no kind", () => {
    const look = windowLook(registry, { appId: "inspector", instanceKey: "" });
    expect(look.hue).toBe("var(--accent-2)");
    expect(look.kind).toBeNull();
    expect(look.app?.id).toBe("inspector");
  });

  it("knows nothing of an app that isn't registered", () => {
    expect(windowLook(registry, { appId: "nope", instanceKey: "" })).toEqual({ hue: null, kind: null, app: null });
  });

  it("marks a grey app's window as work in progress, in its app's hue", () => {
    const look = windowLook(registry, { appId: "vault", instanceKey: "" });
    expect(look.kind).toBe("wip");
    expect(look.hue).toBe("var(--accent-2)");
    expect(look.app?.id).toBe("vault");
  });

  it("draws the Roadmap in the system hue, with no kind", () => {
    expect(windowLook(registry, { appId: ROADMAP_APP_ID, instanceKey: "" })).toEqual({
      hue: "var(--muted)",
      kind: null,
      app: null,
    });
  });
});

describe("appHue", () => {
  it("gives an app its group's colour, the one the rack's tray uses", () => {
    expect(appHue(stub({ category: "system" }))).toBe("var(--muted)");
    expect(appHue(stub({ category: "trust" }))).toBe("var(--accent-2)");
    expect(appHue(stub({ category: "create" }))).toBe("var(--accent-3)");
    expect(appHue(stub({ category: "trade" }))).toBe("var(--accent)");
  });

  it("has a colour for every group", () => {
    for (const c of CATEGORY_ORDER) expect(CATEGORY_HUE[c]).toMatch(/^var\(--[\w-]+\)$/);
  });
});
