// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RadarItem, RadarList } from "../feed";

/**
 * The window's wiring, mounted in jsdom: what a double-click on a row, a click on Inspect, a filter tick and Try
 * again do. React Query is replaced by a stub that records the options it was asked with.
 */

const state = vi.hoisted(() => ({
  opts: undefined as { queryKey?: unknown } | undefined,
  data: undefined as RadarList | undefined,
  loadingError: false,
  open: vi.fn<(appId: string, params?: Record<string, string>) => boolean>(() => true),
  refetch: vi.fn(async () => undefined),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (o: { queryKey?: unknown }) => {
    state.opts = o;
    return {
      isPending: false,
      isLoadingError: state.loadingError,
      isRefetchError: false,
      error: state.loadingError ? new Error("x") : null,
      data: state.loadingError ? undefined : state.data,
      dataUpdatedAt: 0,
      refetch: state.refetch,
    };
  },
  queryOptions: (o: unknown) => o,
}));
vi.mock("@arcos/shell", () => ({
  useDesktop: () => ({ open: state.open }),
  dragSourceProps: () => ({ draggable: true }),
}));

import RadarWindow from "../Window";

const TOKEN = "0x470f09ae20163d5e243f6530fb328912a8fcb099";
const row: RadarItem = {
  address: TOKEN,
  symbol: "RDR",
  name: "Radar token",
  source: "v3",
  firstSeen: "2026-10-08T11:55:00.000Z",
  firstSeenMs: Date.parse("2026-10-08T11:55:00.000Z"),
  passed: 6,
  total: 9,
  bestPoolDepth: "2500000000",
  decimals: 18,
  launchpad: null,
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(RadarWindow, { winId: "w-1", params: {} })));
}
const dblclick = (el: Element) => act(async () => el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
  state.opts = undefined;
  state.data = { rows: [row], indexedAt: Date.parse("2026-10-08T12:00:00.000Z"), servedAt: Date.parse("2026-10-08T12:00:00.000Z") };
  state.loadingError = false;
  state.open.mockClear();
  state.refetch.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllEnvs();
});

describe("Radar's window wiring", () => {
  it("opens Inspector on the token once when a row is double-clicked", async () => {
    await mount();
    await dblclick(host.querySelector("li")!);
    expect(state.open).toHaveBeenCalledTimes(1);
    expect(state.open).toHaveBeenCalledWith("inspector", { token: TOKEN });
  });

  it("opens Inspector from the Inspect button's click alone, not from a double-click on it", async () => {
    await mount();
    const button = host.querySelector('button[aria-label="Inspect RDR"]')!;
    await act(async () => (button as HTMLButtonElement).click());
    expect(state.open).toHaveBeenCalledTimes(1);
    expect(state.open).toHaveBeenCalledWith("inspector", { token: TOKEN });
    await dblclick(button);
    expect(state.open).toHaveBeenCalledTimes(1);
  });

  it("asks for the liquid feed once Has liquidity is ticked", async () => {
    await mount();
    expect(state.opts?.queryKey).toEqual(["radar", "all"]);
    const box = [...host.querySelectorAll("label")].find((l) => l.textContent?.includes("Has liquidity"))!.querySelector("input")!;
    await act(async () => box.click());
    expect(box.checked).toBe(true);
    expect(state.opts?.queryKey).toEqual(["radar", "liquid"]);
    const passing = [...host.querySelectorAll("label")].find((l) => l.textContent?.includes("At least 5 checks pass"))!.querySelector("input")!;
    await act(async () => passing.click());
    expect(state.opts?.queryKey).toEqual(["radar", "liquid-passing"]);
  });

  it("asks the query again from Try again", async () => {
    state.loadingError = true;
    await mount();
    const button = [...host.querySelectorAll("button")].find((b) => b.textContent === "Try again")!;
    await act(async () => button.click());
    expect(state.refetch).toHaveBeenCalledTimes(1);
  });
});
