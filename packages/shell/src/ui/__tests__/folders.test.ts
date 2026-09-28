import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FOLDER_APP_ID, buildRegistry, type AppManifest, type DesktopWindow } from "../../core";
import { AppBody } from "../AppBody";
import { FolderCell } from "../DeskCells";
import { DeskFolders } from "../DeskFolders";
import { FolderArt } from "../FolderArt";
import { FolderItem, FolderWindow } from "../FolderWindow";
import { RegistryProvider } from "../registry";

const app = (id: string, name: string, category: AppManifest["category"], over: Partial<AppManifest> = {}): AppManifest => ({
  id,
  name,
  blurb: `${name} blurb`,
  icon: (() => null) as unknown as AppManifest["icon"],
  category,
  window: { w: 400, h: 300 },
  load: async () => ({ default: () => null }),
  requiresWallet: false,
  release: "r0",
  ...over,
});

const APPS = [
  app("finder", "Finder", "system"),
  app("wallet", "Wallet", "system"),
  app("about", "About", "system"),
  app("revoke", "Revoke", "system", { comingSoon: true, release: "r1" }),
  app("inspector", "Inspector", "trust"),
  app("vault", "Vault", "trust", { comingSoon: true, release: "r2" }),
  app("mint", "Mint", "create"),
];
const el = {} as HTMLElement;
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("FolderArt", () => {
  it("draws up to three cards from the first apps and counts every app, grey ones included", () => {
    const html = renderToStaticMarkup(createElement(FolderArt, { apps: APPS.slice(0, 4), hue: "var(--muted)" }));
    expect(html).toMatch(/^<span class="os-folder" style="--os-group:var\(--muted\)" aria-hidden="true">/);
    expect(count(html, 'class="os-folder-card"')).toBe(3);
    expect(html).toContain('<span class="os-folder-count">4</span>');
  });
});

describe("FolderCell", () => {
  it("names its folder and count, and opens it with the cell it was clicked in", () => {
    const onOpen = vi.fn();
    const cell = FolderCell({ category: "system", apps: APPS.slice(0, 4), onOpen }) as ReactElement<{
      "aria-label": string;
      onClick: (e: { currentTarget: HTMLElement }) => void;
    }>;
    expect(cell.props["aria-label"]).toBe("System: 4 items");
    cell.props.onClick({ currentTarget: el });
    expect(onOpen).toHaveBeenCalledWith("system", el);
  });
});

describe("DeskFolders", () => {
  it("stands a folder for each category that has apps, in the rack's order", () => {
    const html = renderToStaticMarkup(createElement(DeskFolders, { apps: APPS, onOpenFolder: () => {} }));
    const labels = [...html.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);
    expect(labels).toEqual(["Desktop", "System: 4 items", "Trust: 2 items", "Create: 1 item"]);
  });
});

describe("FolderWindow", () => {
  it("lists the folder's apps, dims and tags the grey ones, and counts them all in the status line", () => {
    const trust = APPS.filter((m) => m.category === "trust");
    const html = renderToStaticMarkup(createElement(FolderWindow, { category: "trust", apps: trust, onOpen: () => {} }));
    expect(count(html, 'class="os-icon"')).toBe(2);
    expect(html).toContain('aria-label="Vault, work in progress"');
    expect(count(html, 'data-soon="true"')).toBe(1);
    expect(html).toContain('<span class="os-soon">Soon</span>');
    expect(html).toContain('<p class="os-group-status">2 items</p>');
  });
});

describe("FolderItem", () => {
  it("opens its app from itself, and reads out its name and blurb while pointed at or focused", () => {
    const onOpen = vi.fn();
    const onHint = vi.fn();
    const item = FolderItem({ m: APPS[0], onOpen, onHint }) as ReactElement<Record<string, (e?: unknown) => void>>;
    item.props.onClick({ currentTarget: el });
    expect(onOpen).toHaveBeenCalledWith("finder", el);
    item.props.onPointerEnter();
    expect(onHint).toHaveBeenLastCalledWith("Finder: Finder blurb");
    item.props.onPointerLeave();
    expect(onHint).toHaveBeenLastCalledWith(null);
    item.props.onFocus();
    expect(onHint).toHaveBeenLastCalledWith("Finder: Finder blurb");
    item.props.onBlur();
    expect(onHint).toHaveBeenLastCalledWith(null);
  });
});

describe("AppBody", () => {
  it("mounts a folder window's apps in place of an app", () => {
    const win: DesktopWindow = {
      winId: "w-1",
      appId: FOLDER_APP_ID,
      instanceKey: "trust",
      params: { group: "trust" },
      title: "Trust",
      size: { w: 380, h: 204 },
      flush: true,
      z: 1,
      minimized: false,
      maximized: false,
      cascade: 0,
      rect: null,
    };
    const html = renderToStaticMarkup(
      createElement(RegistryProvider, { value: buildRegistry(APPS) }, createElement(AppBody, { win })),
    );
    expect(html).toContain('class="os-group"');
    expect(html).toContain('aria-label="Inspector"');
    expect(html).toContain("2 items");
  });
});
