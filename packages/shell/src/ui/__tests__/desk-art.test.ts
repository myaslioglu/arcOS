import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AppManifest, DeskItem } from "../../core";
import { DeskItemCell } from "../DeskCells";
import { DeskFolders } from "../DeskFolders";
import { DeskGlyph } from "../DeskGlyph";

const icon = (() => null) as unknown as DeskItem["icon"];
const README: DeskItem = {
  id: "readme",
  label: "readme.txt",
  blurb: "What 4rc.OS is",
  art: "file",
  ext: "TXT",
  icon,
  hue: "var(--muted)",
  action: { kind: "app", appId: "about" },
};
const GITHUB: DeskItem = {
  id: "github",
  label: "GitHub",
  blurb: "The source code",
  art: "link",
  icon,
  hue: "var(--muted)",
  action: { kind: "href", href: "https://github.com/myaslioglu/arcOS" },
};
const el = {} as HTMLElement;

describe("DeskGlyph", () => {
  it("draws a file as a page with a folded corner, its glyph and its extension", () => {
    const html = renderToStaticMarkup(createElement(DeskGlyph, { item: README }));
    expect(html).toMatch(/^<span class="os-file" aria-hidden="true"><svg viewBox="0 0 54 66" class="os-file-page">/);
    expect(html).toContain('class="os-file-sheet"');
    expect(html).toContain('class="os-file-fold"');
    expect(html).toContain('<span class="os-file-ext">TXT</span>');
  });

  it("draws a link as a desk-sized tile with the arrow badge", () => {
    const html = renderToStaticMarkup(createElement(DeskGlyph, { item: GITHUB }));
    expect(html).toMatch(/^<span class="os-icon-tile os-icon-tile--lg os-shortcut" aria-hidden="true">/);
    expect(html).toContain('<span class="os-shortcut-arrow"><svg');
  });
});

describe("DeskItemCell", () => {
  it("opens a link in a new tab, without an opener", () => {
    const onOpen = vi.fn();
    const html = renderToStaticMarkup(createElement(DeskItemCell, { item: GITHUB, loose: true, onOpen }));
    expect(html).toMatch(
      /^<a href="https:\/\/github.com\/myaslioglu\/arcOS" target="_blank" rel="noopener noreferrer" class="os-desk-cell os-desk-cell--loose"/,
    );
    expect(html).toContain('aria-label="GitHub: The source code (opens in a new tab)"');
  });

  it("opens an app item with the cell it was clicked in", () => {
    const onOpen = vi.fn();
    const cell = DeskItemCell({ item: README, loose: false, onOpen }) as ReactElement<{
      className: string;
      onClick: (e: { currentTarget: HTMLElement }) => void;
    }>;
    expect(cell.props.className).toBe("os-desk-cell");
    cell.props.onClick({ currentTarget: el });
    expect(onOpen).toHaveBeenCalledWith(README, el);
  });
});

describe("DeskFolders", () => {
  it("stands the desk items after the folders, in the last column", () => {
    const apps: AppManifest[] = [
      {
        id: "finder",
        name: "Finder",
        blurb: "",
        icon,
        category: "system",
        window: { w: 400, h: 300 },
        load: async () => ({ default: () => null }),
        requiresWallet: false,
        release: "r0",
      },
    ];
    const html = renderToStaticMarkup(
      createElement(DeskFolders, { apps, items: [README, GITHUB], onOpenFolder: () => {}, onOpenItem: () => {} }),
    );
    const labels = [...html.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);
    expect(labels).toEqual([
      "Desktop",
      "System: 1 item",
      "readme.txt: What 4rc.OS is",
      "GitHub: The source code (opens in a new tab)",
    ]);
    expect(html.split("os-desk-cell--loose").length - 1).toBe(2);
  });
});
