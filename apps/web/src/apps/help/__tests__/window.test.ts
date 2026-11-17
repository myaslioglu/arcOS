// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appsFor } from "../../registry";
import { SECTIONS } from "../copy";
import { guideGroups } from "../guide";

/**
 * Help's window, mounted in jsdom: its sections and jump links, a card per app from the registry, and the buttons that
 * open apps through the desktop. The desktop is a stand-in that records what it was asked to open.
 */

const opened = vi.hoisted(() => [] as string[]);
const registry = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock("@arcos/shell", async (original) => {
  const real = await original<typeof import("@arcos/shell")>();
  return {
    ...real,
    useDesktop: () => ({ open: (id: string) => (opened.push(id), true), notify: () => undefined }),
    useRegistry: () => ({ list: registry.list, byId: new Map() }),
  };
});

import HelpWindow, { HelpGuide } from "../Window";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;


async function mount(el: ReturnType<typeof createElement>) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(el));
}
const guide = (network: "mainnet" | "testnet") =>
  createElement(HelpGuide, {
    groups: guideGroups(appsFor(network), network),
    network,
    chainName: network === "mainnet" ? "Arc" : "Arc Testnet",
    onOpen: (id: string) => opened.push(id),
  });
const cardOf = (id: string) => host.querySelector<HTMLElement>(`li[data-app="${id}"]`)!;
const buttonIn = (scope: ParentNode, text: string) => [...scope.querySelectorAll("button")].find((b) => b.textContent === text)!;
const click = (el: HTMLElement) => act(async () => el.click());

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  opened.length = 0;
});

describe("the Help window", () => {
  it("shows the five sections as headings, with a jump link to each", async () => {
    await mount(guide("mainnet"));
    expect([...host.querySelectorAll("h2")].map((h) => h.textContent)).toEqual(SECTIONS.map((s) => s.heading));
    const nav = host.querySelector('nav[aria-label="Help sections"]')!;
    expect([...nav.querySelectorAll("button")].map((b) => b.textContent)).toEqual(SECTIONS.map((s) => s.jump));
  });

  it("jumps to a section by scrolling only its own scroller, and moves focus to the section's heading", async () => {
    await mount(guide("mainnet"));
    const nav = host.querySelector('nav[aria-label="Help sections"]')!;
    const scroller = host.querySelector<HTMLElement>("[data-help-scroll]")!;
    const apps = [...host.querySelectorAll("h2")].find((h) => h.textContent === "What can I do here?")!;
    // jsdom lays nothing out: the heading is put 500px below the scroller's top, which sits 40px down the page.
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({ top: 40 } as DOMRect);
    vi.spyOn(apps, "getBoundingClientRect").mockReturnValue({ top: 540 } as DOMRect);
    const intoView = vi.fn();
    Element.prototype.scrollIntoView = intoView;
    await click(buttonIn(nav, "Apps"));
    expect(document.activeElement).toBe(apps);
    expect(scroller.scrollTop).toBe(492);
    expect(intoView).not.toHaveBeenCalled();
  });

  it("gives each app a card with its icon, what it does, when to use it, and a button that opens it", async () => {
    await mount(guide("mainnet"));
    const inspector = cardOf("inspector");
    expect(inspector.querySelector("h4")?.textContent).toBe("Inspector");
    expect(inspector.textContent).toContain("Use it before you buy a token you don't know.");
    expect(inspector.querySelector(".os-icon-tile svg")).not.toBeNull();
    const open = buttonIn(inspector, "Open Inspector");
    expect(open).toBeDefined();
    await click(open);
    expect(opened).toEqual(["inspector"]);
  });

  it("on mainnet, shows Vault and Vesting as coming after the audit, and opens their stand-in to read more", async () => {
    await mount(guide("mainnet"));
    for (const [id, name] of [["vault", "Vault"], ["vesting", "Vesting"]] as const) {
      const c = cardOf(id);
      expect(c.dataset.coming).toBe("true");
      expect(c.textContent).toContain("Soon: after the audit");
      await click(buttonIn(c, `Read more about ${name}`));
    }
    expect(opened).toEqual(["vault", "vesting"]);
    expect(host.textContent).not.toContain("Mainnet only");
    expect(host.textContent).not.toContain("faucet");
  });

  it("on testnet, shows Vault and Vesting live, marks the mainnet-only apps, and links the faucet", async () => {
    await mount(guide("testnet"));
    for (const id of ["vault", "vesting"]) {
      expect(cardOf(id).dataset.coming, id).toBeUndefined();
      expect(cardOf(id).textContent, id).not.toContain("Soon");
    }
    for (const id of ["watchdog", "radar", "stats"]) expect(cardOf(id).textContent, id).toContain("Mainnet only");
    const faucet = host.querySelector<HTMLAnchorElement>('a[href="https://faucet.circle.com"]');
    expect(faucet?.textContent).toBe("Open Circle's faucet");
    expect(faucet?.rel).toBe("noopener noreferrer");
    expect(host.textContent).toContain("This is the testnet site.");
  });

  it("opens Wallet from Get started, and never shows the meme teaser or Help itself", async () => {
    await mount(guide("mainnet"));
    await click(buttonIn(host, "Open Wallet"));
    expect(opened).toEqual(["wallet"]);
    expect(cardOf("meme")).toBeNull();
    expect(cardOf("help")).toBeNull();
    expect(host.textContent?.toLowerCase()).not.toContain("meme");
  });

  it("builds its cards from the desktop's registry and opens apps through the desktop", async () => {
    registry.list = appsFor("testnet");
    await mount(createElement(HelpWindow));
    expect([...host.querySelectorAll("li[data-app]")].map((li) => (li as HTMLElement).dataset.app)).toEqual(
      guideGroups(appsFor("testnet"), "testnet").flatMap((g) => g.cards.map((c) => c.app.id)),
    );
    await click(buttonIn(cardOf("drop"), "Open Drop"));
    expect(opened).toEqual(["drop"]);
  });
});
