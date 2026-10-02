import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildRegistry } from "../../core";
import { MenuBar } from "../MenuBar";
import { RegistryProvider } from "../registry";

const noop = () => {};

function render(badge?: string): string {
  const bar = createElement(MenuBar, {
    brand: "4rc.OS",
    badge,
    windows: [],
    activeId: null,
    touch: false,
    onSearch: noop,
    onOpenApp: noop,
    onAbout: noop,
    onRoadmap: noop,
    onFocus: noop,
    onCloseActive: noop,
    onMinimizeActive: noop,
    onZoomActive: noop,
    onSnapActive: noop,
    onTile: noop,
    onMinimizeAll: noop,
    onCloseAll: noop,
    onShortcuts: noop,
  });
  return renderToStaticMarkup(createElement(RegistryProvider, { value: buildRegistry([]) }, bar));
}

// The testnet site passes "Testnet": a label beside the brand, on every screen size, so no one takes it for 4rc.OS.
describe("the menu bar's badge", () => {
  it("shows the badge beside the brand when one is given", () => {
    const html = render("Testnet");
    expect(html).toMatch(/<span class="os-network-badge">Testnet<\/span>/);
    expect(html.indexOf("os-network-badge")).toBeLessThan(html.indexOf("os-app-name"));
  });

  it("shows none without one", () => {
    expect(render()).not.toMatch(/os-network-badge/);
    expect(render("")).not.toMatch(/os-network-badge/);
  });
});
