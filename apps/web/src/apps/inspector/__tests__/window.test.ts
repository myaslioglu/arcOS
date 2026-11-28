// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Report } from "@arcos/inspector";

/**
 * The Inspector window: its "Watch with Watchdog" button, which opens the Watchdog app on the report's token through the
 * desktop, never by importing the app, and only on the mainnet site; and its chain picker, which shows once the site
 * reads a chain besides Arc. The report comes from a React Query stub (which keeps the query's options, so a test can
 * run its queryFn), so nothing here reads the chain, and the addresses are test fixtures.
 */

type Query = { queryKey: unknown[]; enabled: boolean; queryFn: () => Promise<unknown> };
const state = vi.hoisted(() => ({
  report: undefined as Report | undefined,
  error: null as unknown,
  query: undefined as Query | undefined,
  open: vi.fn<(appId: string, params?: Record<string, string>) => boolean>(() => true),
  notify: vi.fn<(message: string, kind?: string) => void>(),
  setTitle: vi.fn<(winId: string, title: string) => void>(),
  trackEvent: vi.fn<(name: string, props?: Record<string, string | number>) => void>(),
}));
vi.mock("wagmi", () => ({ usePublicClient: () => undefined }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: Query) => {
    state.query = options;
    return { data: state.report, error: state.error };
  },
}));
vi.mock("@arcos/inspector", () => ({ NotAContract: class NotAContract extends Error {}, inspect: vi.fn() }));
vi.mock("@arcos/shell", () => ({
  useDesktop: () => ({ open: state.open, notify: state.notify, setTitle: state.setTitle }),
  useDropTarget: () => ({ over: false, props: {} }),
  dropParams: (item: { address: string }) => ({ token: item.address }),
}));
vi.mock("@/lib/indexed-pools", () => ({ fetchIndexedExtras: vi.fn(async () => ({ extraPools: [] })) }));
vi.mock("@/lib/analytics", () => ({ trackEvent: state.trackEvent }));

import InspectorWindow from "../Window";
import { inspector } from "../manifest";
import { BUSY, ServerReportError } from "../server-report";

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
  state.error = null;
  state.query = undefined;
  state.open.mockClear();
  state.notify.mockClear();
  state.setTitle.mockClear();
  state.trackEvent.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

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

/** The window mounted for real, for clicks and typing; `done` unmounts it. */
async function mounted(params: Record<string, string>) {
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  await act(async () => root.render(createElement(InspectorWindow, { winId: "w-1", params })));
  return {
    host,
    button: (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === text)!,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

/** What typing or pasting `value` into an input does: React reads the input event. */
function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const onBase = {
  ...report,
  address: BASE_USDC,
  chain: "base",
  chainId: 8453,
  token: { name: "USD Coin", symbol: "USDC", decimals: 6, totalSupply: "1000" },
  findings: [{ id: "holders", status: "fail", title: "Top 10 wallets hold 80%", detail: "Excludes pools.", evidenceUrl: null, fixAppId: "vesting" }],
  blockNumber: "1",
  generatedAt: "2026-11-28T00:00:00.000Z",
} as unknown as Report;

describe("Inspector while the site reads Arc alone", () => {
  it("has no chain picker, Arc's placeholder and Arc's footer, on mainnet with the flag unset", () => {
    const html = render();
    expect(html).not.toContain("<select");
    expect(html).toContain('placeholder="0x3600000000000000000000000000000000000000"');
    expect(html).not.toContain("Read by the ArcOS server");
  });

  it("keeps Arc's query and title, and counts the chain with the inspection", async () => {
    const view = await mounted({ token: TOKEN });
    expect(state.query?.queryKey).toEqual(["inspect", 5042, TOKEN.toLowerCase()]);
    expect(state.setTitle).toHaveBeenLastCalledWith("w-1", "Inspector — WDG");
    await view.done();
  });

  it("says a chain it doesn't read is not read here, and never inspects the address on Arc instead", () => {
    const html = renderToStaticMarkup(createElement(InspectorWindow, { winId: "w-1", params: { chain: "base", token: BASE_USDC } }));
    expect(html).toContain("Inspector doesn&#x27;t read Base on this site.");
    expect(state.query?.enabled).toBe(false);
    const other = renderToStaticMarkup(createElement(InspectorWindow, { winId: "w-1", params: { chain: "<b>x</b>", token: BASE_USDC } }));
    expect(other).toContain("Inspector doesn&#x27;t read that chain on this site.");
    expect(other).not.toContain("<b>x</b>");
  });
});

describe("Inspector once the site reads other chains", () => {
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_INSPECT_CHAINS", "base"));

  it("offers a Chain picker, Arc first, on the mainnet site only", () => {
    state.report = undefined;
    const html = render();
    expect(html).toMatch(/<select[^>]*aria-label="Chain"[^>]*>(?:<option value="arc"[^>]*>Arc<\/option>)<option value="base">Base<\/option><\/select>/);
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "testnet");
    expect(render()).not.toContain("<select");
  });

  it("reads another chain's report from this site's server, and counts it with its chain", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json(onBase));
    vi.stubGlobal("fetch", fetchFn);
    const view = await mounted({ chain: "base", token: BASE_USDC });
    expect(state.query?.queryKey).toEqual(["inspect", 8453, BASE_USDC.toLowerCase()]);
    expect(state.query?.enabled).toBe(true);
    await expect(state.query!.queryFn()).resolves.toMatchObject({ chain: "base", address: BASE_USDC });
    expect(fetchFn).toHaveBeenCalledWith(`/api/inspect/base/${BASE_USDC}`, { headers: { accept: "application/json" } });
    expect(state.trackEvent).toHaveBeenCalledWith("inspect_run", { passed: 0, total: 0, chain: "base" });
    await view.done();
  });

  it("shows another chain's report with its name, its explorers and the server's footer, and no Watchdog or fix button", async () => {
    state.report = onBase;
    const view = await mounted({ chain: "base", token: BASE_USDC });
    const text = view.host.textContent!;
    expect(state.setTitle).toHaveBeenLastCalledWith("w-1", "Inspector — USDC - Base");
    expect(text).toContain("Open on Basescan");
    expect(text).toContain("Read by the ArcOS server; reports are kept up to 5 minutes.");
    expect(text).toContain("Automated analysis, not investment advice.");
    expect(text).not.toContain("Watch with Watchdog");
    expect(text).not.toContain("Vest in Vesting");
    const links = [...view.host.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toContain(`https://base.blockscout.com/token/${BASE_USDC}`);
    expect(links).toContain(`https://basescan.org/token/${BASE_USDC}`);
    expect((view.host.querySelector("select") as HTMLSelectElement).value).toBe("base");
    await view.done();
  });

  it("shares the chain's proof page", async () => {
    state.report = onBase;
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const view = await mounted({ chain: "base", token: BASE_USDC });
    await act(async () => view.button("Share proof page").click());
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/t/base/${BASE_USDC}`);
    await view.done();
  });

  it("keeps Arc's report Arc's: the Watchdog button, the fix button and the bare proof link", async () => {
    state.report = { ...report, findings: [{ id: "holders", status: "fail", title: "Top 10 wallets hold 80%", detail: "x", evidenceUrl: null, fixAppId: "vesting" }] } as unknown as Report;
    const view = await mounted({ token: TOKEN });
    expect(view.host.textContent).toContain("Watch with Watchdog");
    expect(view.host.textContent).toContain("Vest in Vesting");
    expect(view.host.textContent).not.toContain("Read by the ArcOS server");
    await view.done();
  });

  it("fills the address and picks the chain from a pasted link, then opens that chain's Inspector", async () => {
    state.report = undefined;
    const view = await mounted({});
    const input = view.host.querySelector("input")!;
    const select = view.host.querySelector("select") as HTMLSelectElement;
    await act(async () => type(input, `https://basescan.org/token/${BASE_USDC}`));
    expect(input.value).toBe(BASE_USDC);
    expect(select.value).toBe("base");
    expect(input.getAttribute("placeholder")).toBe(BASE_USDC);
    await act(async () => view.button("Inspect").click());
    expect(state.open).toHaveBeenCalledWith("inspector", { chain: "base", token: BASE_USDC });
    await view.done();
  });

  it("opens a bare address on the chain picked, and Arc's as it always has", async () => {
    state.report = undefined;
    const view = await mounted({});
    const input = view.host.querySelector("input")!;
    const select = view.host.querySelector("select") as HTMLSelectElement;
    await act(async () => type(input, TOKEN));
    await act(async () => view.button("Inspect").click());
    expect(state.open).toHaveBeenLastCalledWith("inspector", { token: TOKEN });
    await act(async () => {
      select.value = "base";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => view.button("Inspect").click());
    expect(state.open).toHaveBeenLastCalledWith("inspector", { chain: "base", token: TOKEN });
    await view.done();
  });

  it("says so when a link names a chain the site doesn't read, and opens nothing", async () => {
    state.report = undefined;
    const view = await mounted({});
    const input = view.host.querySelector("input")!;
    await act(async () => type(input, `https://etherscan.io/token/${BASE_USDC}`));
    await act(async () => view.button("Inspect").click());
    expect(state.notify).toHaveBeenCalledWith("Inspector doesn't read Ethereum on this site.", "warn");
    expect(state.open).not.toHaveBeenCalled();
    await view.done();
  });

  it("says so when a link is the testnet's, rather than read the address on mainnet's Arc", async () => {
    state.report = undefined;
    const view = await mounted({});
    const input = view.host.querySelector("input")!;
    const select = view.host.querySelector("select") as HTMLSelectElement;
    const link = `https://testnet.4rcos.com/t/${BASE_USDC}`;
    await act(async () => type(input, link));
    expect(input.value).toBe(link);
    expect(select.value).toBe("arc");
    await act(async () => view.button("Inspect").click());
    expect(state.notify).toHaveBeenCalledWith("Inspector doesn't read Arc Testnet on this site.", "warn");
    expect(state.open).not.toHaveBeenCalled();
    await view.done();
  });

  it("words the server's refusals in the window's own words, and anything else as the network", () => {
    state.report = undefined;
    const html = () => renderToStaticMarkup(createElement(InspectorWindow, { winId: "w-1", params: { chain: "base", token: BASE_USDC } }));
    state.error = new ServerReportError(BUSY);
    expect(html()).toContain("Inspector is busy. Try again in a few seconds.");
    state.error = new Error("https://node.example/v2/secret");
    expect(html()).toContain("Couldn&#x27;t reach the network. Try again.");
    expect(html()).not.toContain("node.example");
  });
});

describe("Inspector's windows", () => {
  it("keeps one per token on Arc, keyed as it always was, and one per token on each other chain", () => {
    expect(inspector.instanceKey!({ token: "0xAbC" })).toBe("0xabc");
    expect(inspector.instanceKey!({ chain: "arc", token: "0xAbC" })).toBe("0xabc");
    expect(inspector.instanceKey!({ chain: "base", token: "0xAbC" })).toBe("base:0xabc");
  });
});
