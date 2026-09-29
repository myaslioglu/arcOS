import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MotionConfig } from "framer-motion";
import { describe, expect, it } from "vitest";
import { buildRegistry, type AppManifest, type DesktopWindow } from "../../core";
import { RegistryProvider } from "../registry";
import { WindowManager, type Origin } from "../WindowManager";
import { windowMotion } from "../window-motion";

const FROM: Origin = { x: 120, y: 340 };

describe("windowMotion", () => {
  describe("with no reduced-motion setting", () => {
    it("grows a window out of the icon it was opened from, and shrinks it back on close", () => {
      expect(windowMotion(FROM, false)).toEqual({
        initial: { opacity: 0, scale: 0.14 },
        animate: { opacity: 1, scale: 1, y: 0 },
        exit: { opacity: 0, scale: 0.14 },
        transition: { duration: 0.34, ease: [0.2, 0.75, 0.25, 1], opacity: { duration: 0.2 } },
      });
    });

    it("fades in a window with no icon to come from with a small rise, and out with a small drop", () => {
      expect(windowMotion(undefined, false)).toEqual({
        initial: { opacity: 0, scale: 0.97, y: 10 },
        animate: { opacity: 1, scale: 1, y: 0 },
        exit: { opacity: 0, scale: 0.97, y: 8 },
        transition: { duration: 0.16, ease: [0.22, 1, 0.36, 1] },
      });
    });
  });

  describe("under a reduced-motion setting", () => {
    // Opacity is the only property of every pose, so no scale or shift can flash on the way in or jump on the way out.
    it.each([
      ["from an icon", FROM],
      ["from nowhere in particular", undefined],
    ])("a window opened %s fades at full size", (_, origin) => {
      const { initial, animate, exit } = windowMotion(origin, true);
      expect(initial).toEqual({ opacity: 0 });
      expect(animate).toEqual({ opacity: 1 });
      expect(exit).toEqual({ opacity: 0 });
    });

    it("fades over the time it takes with no setting, with an icon or without", () => {
      for (const origin of [FROM, undefined]) {
        expect(windowMotion(origin, true).transition).toEqual(windowMotion(origin, false).transition);
      }
    });
  });
});

const FINDER: AppManifest = {
  id: "finder",
  name: "Finder",
  blurb: "Finder blurb",
  icon: (() => null) as unknown as AppManifest["icon"],
  category: "system",
  window: { w: 480, h: 420 },
  load: async () => ({ default: () => null }),
  requiresWallet: false,
  release: "r0",
};
const WIN: DesktopWindow = {
  winId: "w-1",
  appId: "finder",
  instanceKey: "",
  params: {},
  title: "Finder",
  size: { w: 480, h: 420 },
  flush: false,
  z: 1,
  minimized: false,
  maximized: false,
  cascade: 0,
  rect: null,
};
const noop = () => {};
const ACTIONS = {
  open: () => true,
  setTitle: noop,
  focus: noop,
  minimize: noop,
  toggleMax: noop,
  close: noop,
  closeAll: noop,
  setRect: noop,
  tile: noop,
  minimizeAll: noop,
};

// framer-motion writes a window's `initial` pose into the server's markup, so what a window starts from can be read
// there. `reducedMotion: "always"` stands in for a device that asks for reduced motion: it is what
// useReducedMotionConfig() reads, and WindowManager takes the setting from there and from nowhere else.
describe("WindowManager", () => {
  const START = /<div class="pointer-events-none absolute inset-0"(?: style="([^"]*)")?>/;
  /** The `style` the window's animated wrapper is drawn with before it animates. */
  function startingStyle(setting: "never" | "always", origins: Record<string, Origin>): string {
    const manager = createElement(WindowManager, {
      windows: [WIN],
      activeId: WIN.winId,
      actions: ACTIONS,
      touch: false,
      renderBody: () => null,
      origins,
    });
    const html = renderToStaticMarkup(
      createElement(
        RegistryProvider,
        { value: buildRegistry([FINDER]) },
        createElement(MotionConfig, { reducedMotion: setting }, manager),
      ),
    );
    return html.match(START)?.[1] ?? "";
  }

  it("draws a window opened from an icon at the icon's scale, and one opened from nowhere lifted and shrunk a little", () => {
    expect(startingStyle("never", { "finder:": FROM })).toContain("transform:scale(0.14)");
    expect(startingStyle("never", {})).toContain("transform:translateY(10px) scale(0.97)");
  });

  it.each([
    ["from an icon", { "finder:": FROM }],
    ["from nowhere in particular", {}],
  ])("under a reduced-motion setting draws a window opened %s transparent at full size, with no transform", (_, origins) => {
    const style = startingStyle("always", origins);
    expect(style).toMatch(/(?:^|;)opacity:0(?:;|$)/);
    expect(style).not.toMatch(/(?:^|;)transform:/);
  });
});
