import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DesktopShell } from "../DesktopShell";

// The three components that move with framer-motion (the windows, the launcher, the toasts), each swapped for a marker
// that says which reduced-motion setting the MotionConfig above it holds. framer-motion keeps that setting in its own
// context, MotionConfigContext, and the context's default is "never": a component with no MotionConfig above it moves
// whatever the device asks for.
const framerUser = vi.hoisted(() => async (name: string) => {
  const { createElement, useContext } = await import("react");
  const { MotionConfigContext } = await import("framer-motion");
  return function FramerUser() {
    const { reducedMotion } = useContext(MotionConfigContext);
    return createElement("i", { "data-framer-user": name, "data-reduced-motion": reducedMotion });
  };
});
vi.mock("../WindowManager", async () => ({ WindowManager: await framerUser("window-manager") }));
vi.mock("../Launcher", async () => ({ Launcher: await framerUser("launcher") }));
vi.mock("../Toasts", async () => ({ Toasts: await framerUser("toasts") }));

describe("DesktopShell's motion setting", () => {
  it('sets framer-motion to follow the device ("user") for the windows, the launcher and the toasts', () => {
    const html = renderToStaticMarkup(createElement(DesktopShell, { apps: [], brand: "4rc.OS" }));
    const seen = [...html.matchAll(/<i data-framer-user="([^"]+)" data-reduced-motion="([^"]+)"><\/i>/g)].map(
      ([, user, setting]) => [user, setting],
    );
    expect(seen).toEqual([
      ["window-manager", "user"],
      ["launcher", "user"],
      ["toasts", "user"],
    ]);
  });
});
