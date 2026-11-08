// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatsList } from "../api";

/** The window's wiring, mounted in jsdom: what Copy JSON link and Try again do. React Query is replaced by a stub. */

const state = vi.hoisted(() => ({
  opts: undefined as { queryKey?: unknown; enabled?: boolean } | undefined,
  data: undefined as StatsList | undefined,
  loadingError: false,
  refetch: vi.fn(async () => undefined),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (o: { queryKey?: unknown; enabled?: boolean }) => {
    state.opts = o;
    return {
      isPending: false,
      isLoadingError: state.loadingError,
      isRefetchError: false,
      error: state.loadingError ? new Error("x") : null,
      data: state.loadingError ? undefined : state.data,
      refetch: state.refetch,
    };
  },
  queryOptions: (o: unknown) => o,
}));

import StatsWindow from "../Window";

const NOW = Date.parse("2026-11-08T12:05:00.000Z");
const data: StatsList = {
  asOf: { block: 24_012_345, atMs: NOW - 60_000, behind: 10 },
  items: [{ id: "tokens_created", label: "Tokens created with Mint", value: 7, since: "2026-09-25", source: "onchain", parts: [], links: [] }],
  notes: [],
  servedAt: NOW,
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(StatsWindow, { winId: "w-1", params: {} })));
}
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === text)!;

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
  state.data = data;
  state.loadingError = false;
  state.refetch.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Stats' window wiring", () => {
  it("copies the link to the JSON answer of this site and says so", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await mount();
    await act(async () => button("Copy JSON link").click());
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/api/stats`);
    expect(host.textContent).toContain("Link copied");
  });

  it("says so when the link can't be copied", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => { throw new Error("denied"); }) } });
    await mount();
    await act(async () => button("Copy JSON link").click());
    expect(host.textContent).toContain("Couldn't copy the link");
  });

  it("asks the query again from Try again", async () => {
    state.loadingError = true;
    await mount();
    await act(async () => button("Try again").click());
    expect(state.refetch).toHaveBeenCalledTimes(1);
  });
});
