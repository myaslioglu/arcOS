import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AppManifest, DeskItem, DesktopView } from "../../core";
import { FolderWindow } from "../FolderWindow";
import { TouchHomeView } from "../TouchHome";

const icon = (() => null) as unknown as AppManifest["icon"];
const app = (id: string, name: string, category: AppManifest["category"], over: Partial<AppManifest> = {}): AppManifest => ({
  id,
  name,
  blurb: `${name} blurb`,
  icon,
  category,
  window: { w: 400, h: 300 },
  load: async () => ({ default: () => null }),
  requiresWallet: false,
  release: "r0",
  ...over,
});
const APPS = [
  app("finder", "Finder", "system"),
  app("revoke", "Revoke", "system", { comingSoon: true, release: "r1" }),
  app("inspector", "Inspector", "trust"),
  app("vault", "Vault", "trust", { comingSoon: true, release: "r2" }),
  app("mint", "Mint", "create"),
  app("swap", "Swap", "trade"),
];
const ITEMS: DeskItem[] = [
  {
    id: "readme",
    label: "readme.txt",
    blurb: "What 4rc.OS is",
    art: "file",
    ext: "TXT",
    icon,
    hue: "var(--muted)",
    action: { kind: "app", appId: "about" },
  },
  {
    id: "github",
    label: "GitHub",
    blurb: "The source code",
    art: "link",
    icon,
    hue: "var(--muted)",
    action: { kind: "href", href: "https://github.com/myaslioglu/arcOS" },
  },
];
const SOON = '<span class="os-soon">Soon</span>';

function home(over: { view?: DesktopView; filter?: string } = {}) {
  const onView = vi.fn();
  const props = {
    apps: APPS,
    view: over.view ?? ("folders" as DesktopView),
    filter: over.filter ?? "",
    deskItems: ITEMS,
    onFilter: () => {},
    onView,
    onOpen: () => {},
    onOpenFolder: () => {},
    onOpenDeskItem: () => {},
  };
  return { html: renderToStaticMarkup(createElement(TouchHomeView, props)), props, onView };
}

type Node = { props: { children?: unknown; "aria-label"?: string; onClick?: () => void } };
function* walk(n: unknown): Generator<Node> {
  if (Array.isArray(n)) for (const child of n) yield* walk(child);
  else if (typeof n === "object" && n !== null && "props" in n) {
    yield n as Node;
    yield* walk((n as Node).props.children);
  }
}

describe("TouchHomeView", () => {
  it("shows the search box, the Folders / List switch and a grid of the folders and the desk items", () => {
    const { html } = home();
    expect(html).toContain('aria-label="search"');
    expect(html).toContain('<button type="button" aria-pressed="true" aria-label="Folders" class="os-touch-view">');
    expect(html).toContain('<button type="button" aria-pressed="false" aria-label="List" class="os-touch-view">');
    const grid = html.slice(html.indexOf('class="os-touch-folders"'));
    expect([...grid.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1])).toEqual([
      "System: 2 items",
      "Trust: 2 items",
      "Create: 1 item",
      "Trade: 1 item",
      "readme.txt: What 4rc.OS is",
      "GitHub: The source code (opens in a new tab)",
    ]);
    expect(grid).not.toContain("os-desk-cell--loose");
  });

  it("shows today's category lists in the List view, grey apps tagged Soon", () => {
    const { html } = home({ view: "trays" });
    expect(html).not.toContain("os-touch-folders");
    const plates = [
      ...html.matchAll(/<h2 class="os-touch-plate"><span class="os-tray-led" aria-hidden="true"><\/span>([^<]+)</g),
    ].map((m) => m[1]);
    expect(plates).toEqual(["System", "Trust", "Create", "Trade"]);
    expect(html.split(SOON).length - 1).toBe(2);
  });

  it("tags grey apps Soon in the search results too", () => {
    const { html } = home({ filter: "VAULT " });
    expect(html).toContain("Vault");
    expect(html).toContain(SOON);
    expect(html).not.toContain("os-touch-folders");
  });

  it("switches the view from its two buttons", () => {
    const { props, onView } = home();
    const list = [...walk(TouchHomeView(props))].find((n) => n.props["aria-label"] === "List");
    list?.props.onClick?.();
    expect(onView).toHaveBeenCalledWith("trays");
  });
});

describe("FolderWindow on touch", () => {
  it("opens a folder's apps as rows, grey ones tagged Soon", () => {
    const trust = APPS.filter((m) => m.category === "trust");
    const html = renderToStaticMarkup(createElement(FolderWindow, { category: "trust", apps: trust, touch: true, onOpen: () => {} }));
    expect(html).toMatch(/^<ul class="os-touch-list os-group-rows"/);
    expect(html.split('class="os-touch-row"').length - 1).toBe(2);
    expect(html).toContain(SOON);
    expect(html).not.toContain("os-group-status");
  });
});
