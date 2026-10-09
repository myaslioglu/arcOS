// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Report } from "@arcos/inspector";

/**
 * The Inspector window's "Watch with Watchdog" button: it opens the Watchdog app on the report's token through the
 * desktop, never by importing the app, and only on the mainnet site. The report comes from a React Query stub, so
 * nothing here reads the chain, and the address is a test fixture.
 */

const state = vi.hoisted(() => ({
  report: undefined as Report | undefined,
  open: vi.fn<(appId: string, params?: Record<string, string>) => boolean>(() => true),
  trackEvent: vi.fn<(name: string, props?: Record<string, string | number>) => void>(),
}));
vi.mock("wagmi", () => ({ usePublicClient: () => undefined }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: state.report, error: null }) }));
vi.mock("@arcos/inspector", () => ({ NotAContract: class NotAContract extends Error {}, inspect: vi.fn() }));
vi.mock("@arcos/shell", () => ({
  useDesktop: () => ({ open: state.open, notify: vi.fn(), setTitle: vi.fn() }),
  useDropTarget: () => ({ over: false, props: {} }),
  dropParams: (item: { address: string }) => ({ token: item.address }),
}));
vi.mock("@/lib/indexed-pools", () => ({ fetchExtraPools: vi.fn(async () => []) }));
vi.mock("@/lib/analytics", () => ({ trackEvent: state.trackEvent }));

import InspectorWindow from "../Window";

const TOKEN = "0x470f09ae20163d5e243f6530fb328912a8fcb099";
const report = {
  address: TOKEN,
  network: "mainnet",
  token: { name: "Watched token", symbol: "WDG", decimals: 18, totalSupply: "1000" },
  findings: [],
  passed: 0,
  total: 0,
  counts: { pass: 0, warn: 0, fail: 0, unknown: 0 },
  explorerReachable: true,
  degraded: false,
} as unknown as Report;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const props = { winId: "w-1", params: { token: TOKEN } };
const render = () => renderToStaticMarkup(createElement(InspectorWindow, props));

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
  state.report = report;
  state.open.mockClear();
  state.trackEvent.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe("Inspector's Watch with Watchdog button", () => {
  it("stands next to Share proof page on the mainnet site", () => {
    const html = render();
    expect(html).toMatch(/Share proof page<\/button>(?:<!-- -->)?<button[^>]*>Watch with Watchdog<\/button>/);
  });

  it("is absent on the testnet site, where there are no watches", () => {
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "testnet");
    const html = render();
    expect(html).toContain("Share proof page");
    expect(html).not.toContain("Watch with Watchdog");
  });

  it("is absent before there is a report", () => {
    state.report = undefined;
    expect(render()).not.toContain("Watch with Watchdog");
  });

  it("opens Watchdog on the report's token through the desktop, and counts the click", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root: Root = createRoot(host);
    await act(async () => root.render(createElement(InspectorWindow, props)));
    const button = [...host.querySelectorAll("button")].find((b) => b.textContent === "Watch with Watchdog")!;
    await act(async () => button.click());
    expect(state.trackEvent).toHaveBeenCalledWith("watch_click");
    expect(state.open).toHaveBeenCalledTimes(1);
    expect(state.open).toHaveBeenCalledWith("watchdog", { token: TOKEN });
    await act(async () => root.unmount());
    host.remove();
  });
});
