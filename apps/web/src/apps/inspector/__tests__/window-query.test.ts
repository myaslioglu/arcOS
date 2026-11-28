// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Report } from "@arcos/inspector";

/**
 * The Inspector window over a real QueryClient, the one the desktop shares between its windows: what closing a window
 * does to the read it started. Another chain's request to this site's server ends with the window, and counts nothing;
 * Arc's inspection, read in the browser, runs on into the cache as it always has. `fetch` and Arc's inspection are
 * stubbed, so nothing here reaches the network, and the addresses are test fixtures.
 */

const state = vi.hoisted(() => ({
  trackEvent: vi.fn<(name: string, props?: Record<string, string | number>) => void>(),
  inspect: vi.fn<() => Promise<unknown>>(),
}));
vi.mock("wagmi", () => ({ usePublicClient: () => ({}) }));
vi.mock("@arcos/inspector", async (importOriginal) => ({ ...(await importOriginal<typeof import("@arcos/inspector")>()), inspect: state.inspect }));
vi.mock("@arcos/shell", () => ({
  useDesktop: () => ({ open: () => true, notify: () => undefined, setTitle: () => undefined }),
  useDropTarget: () => ({ over: false, props: {} }),
  dropParams: (item: { address: string }) => ({ token: item.address }),
}));
vi.mock("@/lib/indexed-pools", () => ({ fetchIndexedExtras: vi.fn(async () => ({ extraPools: [] })) }));
vi.mock("@/lib/analytics", () => ({ trackEvent: state.trackEvent }));

import InspectorWindow from "../Window";

const ARC_TOKEN = "0x470f09ae20163d5e243f6530fb328912a8fcb099";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const arcReport = {
  address: ARC_TOKEN,
  network: "mainnet",
  chain: "arc",
  chainId: 5042,
  token: { name: "Watched token", symbol: "WDG", decimals: 18, totalSupply: "1000" },
  findings: [],
  passed: 0,
  total: 0,
  counts: { pass: 0, warn: 0, fail: 0, unknown: 0 },
  explorerReachable: true,
  degraded: false,
  blockNumber: "1",
  generatedAt: "2026-11-28T00:00:00.000Z",
} as unknown as Report;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let client: QueryClient;
let host: HTMLDivElement;
let root: Root;

const open = (params: Record<string, string>) =>
  act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(InspectorWindow, { winId: "w-1", params }))));
const close = () => act(async () => root.unmount());
/** Lets what is in flight land. */
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
  vi.stubEnv("NEXT_PUBLIC_INSPECT_CHAINS", "base");
  client = new QueryClient();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  state.trackEvent.mockClear();
  state.inspect.mockReset();
});
afterEach(() => {
  client.clear();
  host.remove();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("closing an Inspector window", () => {
  it("ends its request to the server for another chain's report, and counts no inspection", async () => {
    // A request the server hasn't answered yet, which ends with its signal, as the browser's fetch does.
    const fetchFn = vi.fn<typeof fetch>(
      (_input, init) => new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true })),
    );
    vi.stubGlobal("fetch", fetchFn);
    await open({ chain: "base", token: BASE_USDC });
    expect(host.textContent).toContain("Asking the ArcOS server…");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const signal = fetchFn.mock.lastCall![1]!.signal!;
    expect(signal.aborted).toBe(false);
    await close();
    await settle();
    expect(signal.aborted).toBe(true);
    expect(state.trackEvent).not.toHaveBeenCalled();
    // Nothing was kept, so the window asks again when it opens again.
    expect(client.getQueryData(["inspect", 8453, BASE_USDC.toLowerCase()])).toBeUndefined();
  });

  it("lets Arc's inspection run on into the cache, and count, as it always has", async () => {
    let finish!: (report: Report) => void;
    state.inspect.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    await open({ token: ARC_TOKEN });
    expect(host.textContent).toContain("Reading the contract…");
    expect(state.inspect).toHaveBeenCalledTimes(1);
    await close();
    await act(async () => finish(arcReport));
    await settle();
    expect(client.getQueryData(["inspect", 5042, ARC_TOKEN])).toBe(arcReport);
    expect(state.trackEvent).toHaveBeenCalledWith("inspect_run", { passed: 0, total: 0, chain: "arc" });
  });
});
