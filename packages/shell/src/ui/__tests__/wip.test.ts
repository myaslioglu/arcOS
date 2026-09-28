import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ROADMAP_APP_ID, buildRegistry, type AppManifest, type DesktopWindow } from "../../core";
import { AppBody } from "../AppBody";
import { RegistryProvider } from "../registry";
import { RoadmapWindow } from "../RoadmapWindow";
import { WorkInProgress } from "../WorkInProgress";

const app = (id: string, name: string, over: Partial<AppManifest> = {}): AppManifest => ({
  id,
  name,
  blurb: `${name} blurb`,
  icon: (() => null) as unknown as AppManifest["icon"],
  category: "trust",
  window: { w: 480, h: 420 },
  load: async () => ({ default: () => null }),
  requiresWallet: false,
  release: "r0",
  ...over,
});

const VAULT = app("vault", "Vault", {
  comingSoon: true,
  release: "r2",
  blurb: "Lock liquidity and team tokens",
  details: ["Will lock tokens until a date you choose.", "Needs its own contracts and an audit first."],
});
const WATCHDOG = app("watchdog", "Watchdog", {
  comingSoon: true,
  release: "r1",
  blurb: "Alerts when a token you hold changes",
  details: ["Will alert you when a token you hold changes.", "Needs a server that watches the chain."],
});
const FINDER = app("finder", "Finder", { category: "system" });
const REPO = "https://github.com/myaslioglu/arcOS";

const win = (appId: string): DesktopWindow => ({
  winId: "w-1",
  appId,
  instanceKey: "",
  params: {},
  title: appId,
  size: { w: 380, h: 300 },
  flush: false,
  z: 1,
  minimized: false,
  maximized: false,
  cascade: 0,
  rect: null,
});

describe("WorkInProgress", () => {
  it("shows the app, its blurb, what it will do, its stage and where to follow it", () => {
    const html = renderToStaticMarkup(createElement(WorkInProgress, { m: VAULT, repoUrl: REPO }));
    expect(html).toContain('<p class="os-wip-name">Vault</p>');
    expect(html).toContain('<p class="os-wip-blurb">Lock liquidity and team tokens</p>');
    expect(html).toContain("<li>Will lock tokens until a date you choose.</li>");
    expect(html).toContain("<li>Needs its own contracts and an audit first.</li>");
    expect(html).toContain('<span class="os-wip-label">Stage</span>After the audit');
    expect(html).toMatch(
      /<a class="os-wip-link" href="https:\/\/github.com\/myaslioglu\/arcOS" target="_blank" rel="noopener noreferrer">Follow progress on GitHub/,
    );
  });

  it("leaves the link off without a repository URL, and the stage off for the live release", () => {
    const html = renderToStaticMarkup(createElement(WorkInProgress, { m: { ...VAULT, release: "r0" }, repoUrl: "" }));
    expect(html).not.toContain("os-wip-link");
    expect(html).not.toContain("Stage");
  });
});

describe("RoadmapWindow", () => {
  it("lists exactly the grey apps, soonest stage first, each with its stage and blurb", () => {
    const html = renderToStaticMarkup(createElement(RoadmapWindow, { apps: [VAULT, FINDER, WATCHDOG] }));
    const names = [...html.matchAll(/<span class="os-roadmap-name">([^<]+)<\/span>/g)].map((m) => m[1]);
    expect(names).toEqual(["Watchdog", "Vault"]);
    expect(html).toContain('<span class="os-roadmap-stage">Next up</span>');
    expect(html).toContain('<span class="os-roadmap-stage">After the audit</span>');
    expect(html).toContain("Alerts when a token you hold changes");
  });

  it("says so when nothing is in progress", () => {
    expect(renderToStaticMarkup(createElement(RoadmapWindow, { apps: [FINDER] }))).toContain("No apps are in progress.");
  });
});

describe("AppBody", () => {
  const registry = buildRegistry([FINDER, VAULT, WATCHDOG]);
  const body = (appId: string) =>
    renderToStaticMarkup(
      createElement(RegistryProvider, { value: registry }, createElement(AppBody, { win: win(appId), repoUrl: REPO })),
    );

  it("renders a grey app's work in progress window instead of loading the app", () => {
    const html = body("vault");
    expect(html).toContain('class="os-wip"');
    expect(html).toContain("Follow progress on GitHub");
  });

  it("renders the Roadmap for the Roadmap window", () => {
    expect(body(ROADMAP_APP_ID)).toContain('class="os-roadmap"');
  });
});
