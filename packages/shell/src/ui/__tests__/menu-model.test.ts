import { describe, expect, it, vi } from "vitest";
import type { AppManifest } from "../../core";
import { menuModel, type Menu, type MenuEntry, type MenuGroup, type MenuInput, type MenuItem } from "../menu-model";

const app = (id: string, name: string, comingSoon = false): AppManifest => ({
  id,
  name,
  blurb: "",
  icon: (() => null) as unknown as AppManifest["icon"],
  category: "system",
  window: { w: 400, h: 300 },
  load: async () => ({ default: () => null }),
  requiresWallet: false,
  release: comingSoon ? "r2" : "r0",
  comingSoon,
});
const APPS = [app("finder", "Finder"), app("vault", "Vault", true)];

function model(over: Partial<MenuInput> = {}) {
  const on = {
    search: vi.fn(),
    openApp: vi.fn(),
    about: vi.fn(),
    shortcuts: vi.fn(),
    roadmap: vi.fn(),
    github: vi.fn(),
    focus: vi.fn(),
    closeActive: vi.fn(),
    minimizeActive: vi.fn(),
    zoomActive: vi.fn(),
    snapActive: vi.fn(),
    tile: vi.fn(),
    minimizeAll: vi.fn(),
    closeAll: vi.fn(),
    view: vi.fn(),
    theme: vi.fn(),
  };
  const menus = menuModel({
    brand: "4rc.OS",
    apps: APPS,
    windows: [],
    activeId: null,
    view: "folders",
    theme: "system",
    touch: false,
    repoUrl: "https://github.com/myaslioglu/arcOS",
    on,
    ...over,
  });
  return { menus, on };
}

const menu = (menus: Menu[], id: string): Menu => menus.find((m) => m.id === id)!;
const items = (entries: MenuEntry[]): MenuItem[] =>
  entries.flatMap((e) => (e.type === "item" ? [e] : e.type === "group" ? e.items : []));

describe("menuModel", () => {
  it("orders the menus brand, File, Window, View and Help, keeping the brand menu and View on narrow screens", () => {
    const { menus } = model();
    expect(menus.map((m) => m.id)).toEqual(["brand", "file", "window", "view", "help"]);
    expect(menus.filter((m) => m.narrow).map((m) => m.id)).toEqual(["brand", "view"]);
  });

  it("keeps About and Keyboard shortcuts in the brand menu, and the theme out of it", () => {
    const brand = menu(model().menus, "brand");
    expect(brand.brand).toBe(true);
    expect(brand.name).toBe("4rc.OS menu");
    expect(items(brand.entries).map((i) => i.label)).toEqual(["About 4rc.OS", "Keyboard shortcuts"]);
  });

  it("lists every app in File, the grey ones hinted Soon, and opens them", () => {
    const { menus, on } = model();
    const file = items(menu(menus, "file").entries);
    expect(file.map((i) => [i.label, i.hint])).toEqual([
      ["Search…", "⌘K / Ctrl+K"],
      ["Open Finder", undefined],
      ["Open Vault", "Soon"],
      ["Close window", "Esc"],
    ]);
    file[2].onSelect();
    expect(on.openApp).toHaveBeenCalledWith("vault");
    expect(file[3].disabled).toBe(true);
  });

  it("offers the desktop's views and the theme choices in View, each checked as chosen", () => {
    const view = menu(model({ view: "trays", theme: "dark" }).menus, "view");
    expect(view.entries.filter((e): e is MenuGroup => e.type === "group").map((g) => g.label)).toEqual(["Desktop", "Theme"]);
    expect(items(view.entries).map((i) => [i.label, i.role, i.checked])).toEqual([
      ["Folders", "menuitemradio", false],
      ["Trays", "menuitemradio", true],
      ["Light", "menuitemradio", false],
      ["Dark", "menuitemradio", true],
      ["Match system", "menuitemradio", false],
    ]);
  });

  it("hands a View choice to its handler", () => {
    const { menus, on } = model();
    const choices = items(menu(menus, "view").entries);
    choices.find((i) => i.label === "Trays")!.onSelect();
    choices.find((i) => i.label === "Match system")!.onSelect();
    expect(on.view).toHaveBeenCalledWith("trays");
    expect(on.theme).toHaveBeenCalledWith("system");
  });

  it("names the Desktop group's Trays choice \"List\" on touch, matching the touch switch, though the underlying value is unchanged", () => {
    const view = menu(model({ view: "trays", touch: true }).menus, "view");
    expect(items(view.entries).map((i) => [i.label, i.role, i.checked]).slice(0, 2)).toEqual([
      ["Folders", "menuitemradio", false],
      ["List", "menuitemradio", true],
    ]);
    const { menus, on } = model({ touch: true });
    items(menu(menus, "view").entries)
      .find((i) => i.label === "List")!
      .onSelect();
    expect(on.view).toHaveBeenCalledWith("trays");
  });

  it("opens the Roadmap, the repository and About from Help", () => {
    const { menus, on } = model();
    const help = items(menu(menus, "help").entries);
    expect(help.map((i) => i.label)).toEqual(["Keyboard shortcuts", "Roadmap", "GitHub ↗", "About 4rc.OS"]);
    help[1].onSelect();
    help[2].onSelect();
    help[3].onSelect();
    expect(on.roadmap).toHaveBeenCalledTimes(1);
    expect(on.github).toHaveBeenCalledTimes(1);
    expect(on.about).toHaveBeenCalledTimes(1);
  });

  it("leaves GitHub out of Help without a repository URL", () => {
    const help = items(menu(model({ repoUrl: "" }).menus, "help").entries);
    expect(help.map((i) => i.label)).toEqual(["Keyboard shortcuts", "Roadmap", "About 4rc.OS"]);
  });
});
