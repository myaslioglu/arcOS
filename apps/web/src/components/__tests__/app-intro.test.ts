// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { introKey, introOpen, setIntroOpen, type IntroContent } from "@/lib/intro";
import { AppIntro } from "../AppIntro";

/**
 * The first-run explainer Vault and Vesting show: open the first time, a heading's button that hides and shows it
 * (aria-expanded, aria-controls), and the choice kept per browser, with storage that throws read as "open".
 */

const CONTENT: IntroContent = {
  title: "What is Thing?",
  lead: "Thing does one thing.",
  uses: ["A project uses it."],
  steps: ["Pick it.", "Set it.", "Confirm it."],
  limits: ["It can't be undone."],
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;

async function mount(id = "thing") {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(AppIntro, { id, content: CONTENT, art: createElement("svg") })));
}
const toggle = () => host.querySelector<HTMLButtonElement>("h2 button")!;
const panel = () => document.getElementById(toggle().getAttribute("aria-controls")!)!;
const click = (el: HTMLElement) => act(async () => el.click());

beforeEach(() => window.localStorage.clear());
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("AppIntro", () => {
  it("opens the first time, as a section named by its heading, with the three steps in order", async () => {
    await mount();
    const section = host.querySelector("section")!;
    expect(document.getElementById(section.getAttribute("aria-labelledby")!)?.tagName).toBe("H2");
    expect(toggle().textContent).toContain("What is Thing?");
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(panel().hidden).toBe(false);
    expect([...panel().querySelectorAll("h3")].map((h) => h.textContent)).toEqual(["Who it's for", "How it works", "Good to know"]);
    expect([...panel().querySelectorAll("ol li")].map((li) => li.textContent)).toEqual([
      "1Step 1: Pick it.",
      "2Step 2: Set it.",
      "3Step 3: Confirm it.",
    ]);
  });

  it("hides from inside, moves focus to its heading's button, and stays hidden in this browser", async () => {
    await mount();
    const hide = [...panel().querySelectorAll("button")].find((b) => b.textContent === "Got it, hide this")!;
    hide.focus();
    await click(hide);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(toggle());
    expect(window.localStorage.getItem(introKey("thing"))).toBe("hidden");

    await act(async () => root.unmount());
    host.remove();
    await mount();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    // Another explainer keeps its own choice.
    expect(introOpen("other")).toBe(true);
  });

  it("opens again from its heading's button, and forgets the hidden choice", async () => {
    window.localStorage.setItem(introKey("thing"), "hidden");
    await mount();
    expect(panel().hidden).toBe(true);
    await click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(panel().hidden).toBe(false);
    expect(window.localStorage.getItem(introKey("thing"))).toBeNull();
  });

  it("follows a change made in another tab", async () => {
    await mount();
    await act(async () => {
      window.localStorage.setItem(introKey("thing"), "hidden");
      window.dispatchEvent(new StorageEvent("storage", { key: introKey("thing") }));
    });
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("renders open on the server, where there is no storage", () => {
    const html = renderToStaticMarkup(createElement(AppIntro, { id: "thing", content: CONTENT, art: null }));
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Thing does one thing.");
  });
});

describe("the explainer's stored choice", () => {
  const throwing = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  } as unknown as Storage;

  it("reads as open when storage throws, and keeps a choice for the page when it can't be stored", () => {
    expect(introOpen("blocked", throwing)).toBe(true);
    setIntroOpen("blocked", false, throwing);
    expect(introOpen("blocked", throwing)).toBe(false);
    setIntroOpen("blocked", true, throwing);
    expect(introOpen("blocked", throwing)).toBe(true);
  });

  it("reads anything but the hidden mark as open", () => {
    window.localStorage.setItem(introKey("odd"), "yes");
    expect(introOpen("odd")).toBe(true);
    window.localStorage.setItem(introKey("odd"), "hidden");
    expect(introOpen("odd")).toBe(false);
  });
});
