import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatsList } from "../api";

// The window reads the counts from React Query; these tests only need its answers. Nothing here reaches the network.
const state = vi.hoisted(() => ({
  opts: undefined as { queryKey?: unknown; enabled?: boolean } | undefined,
  query: {
    isPending: false,
    isLoadingError: false,
    isRefetchError: false,
    error: null as unknown,
    data: undefined as StatsList | undefined,
    refetch: async () => undefined,
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (o: { queryKey?: unknown; enabled?: boolean }) => {
    state.opts = o;
    return state.query;
  },
  queryOptions: (o: unknown) => o,
}));

import { StatsFetchError } from "../api";
import StatsWindow, { statsView } from "../Window";

const NOW = Date.parse("2026-11-08T12:05:00.000Z");
const base = { isPending: false, isLoadingError: false, error: null, data: undefined };
const FACTORY_LOGS = "https://explorer.arc.io/address/0xa68edD822048C00dC816d93005B72F8a50234a24?tab=logs";

const list = (over: Partial<StatsList> = {}): StatsList => ({
  asOf: { block: 24_012_345, atMs: NOW - 5 * 60_000, behind: 40 },
  items: [
    {
      id: "tokens_created",
      label: "Tokens created with Mint",
      value: 1234,
      since: "2026-09-25",
      source: "onchain",
      parts: [{ id: "standard", label: "Standard", value: 1000 }, { id: "mintable", label: "Mintable", value: 234 }],
      links: [{ label: "TokenFactory", href: FACTORY_LOGS }],
    },
    { id: "drops", label: "Drop transactions", value: 321, since: "2026-09-25", source: "onchain", parts: [], links: [] },
    { id: "wallets_signed_in", label: "Wallets signed in", value: 12_345, since: "2026-10-14", source: "server", parts: [], links: [] },
  ],
  notes: ["Drop counts rows, not unique wallets."],
  servedAt: NOW,
  ...over,
});
/** React escapes an apostrophe in static markup; read it back as typed. */
const render = () => renderToStaticMarkup(createElement(StatsWindow, { winId: "w-1", params: {} })).replaceAll("&#x27;", "'");

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
  state.opts = undefined;
  state.query = { isPending: false, isLoadingError: false, isRefetchError: false, error: null, data: undefined, refetch: async () => undefined };
});
afterEach(() => vi.unstubAllEnvs());

describe("statsView", () => {
  it("picks each state in order", () => {
    expect(statsView(false, { ...base, isPending: true })).toBe("elsewhere");
    expect(statsView(true, { ...base, isLoadingError: true, error: new StatsFetchError(404) })).toBe("elsewhere");
    expect(statsView(true, { ...base, isPending: true })).toBe("loading");
    expect(statsView(true, { ...base, isLoadingError: true, error: new StatsFetchError(503) })).toBe("down");
    expect(statsView(true, { ...base, isLoadingError: true, error: new StatsFetchError(500) })).toBe("failed");
    expect(statsView(true, { ...base, isLoadingError: true, error: new StatsFetchError(null) })).toBe("failed");
    expect(statsView(true, { ...base, isLoadingError: true, error: new TypeError("x") })).toBe("failed");
    expect(statsView(true, { ...base, data: list({ asOf: null, items: [] }) })).toBe("waiting");
    expect(statsView(true, { ...base, data: list({ items: [] }) })).toBe("waiting");
    expect(statsView(true, { ...base, data: list() })).toBe("list");
  });
});

describe("Stats", () => {
  it("on testnet says counts are kept for mainnet only, fetches nothing and links to the mainnet site", () => {
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "testnet");
    state.query = { ...state.query, isPending: true };
    const html = render();
    expect(html).toContain("Stats are kept for Arc mainnet only.");
    expect(html).toContain('href="https://4rcos.com/#app:stats"');
    expect(html).not.toContain("Loading the counts");
    expect(state.opts?.enabled).toBe(false);
  });

  it("says the same when the route answers 404", () => {
    state.query = { ...state.query, isLoadingError: true, error: new StatsFetchError(404) };
    expect(render()).toContain("Stats are kept for Arc mainnet only.");
  });

  it("says it is loading, in a status region that is there before the text, and asks the query", () => {
    state.query = { ...state.query, isPending: true };
    const html = render();
    expect(html).toContain('role="status" aria-live="polite">Loading the counts…</p>');
    expect(state.opts?.enabled).toBe(true);
    expect(state.opts?.queryKey).toEqual(["stats"]);
  });

  it("says the counts can't be read, with Try again, when the route answers 503", () => {
    state.query = { ...state.query, isLoadingError: true, error: new StatsFetchError(503) };
    const html = render();
    expect(html).toContain("The usage counts can&#x27;t be read right now.".replaceAll("&#x27;", "'"));
    expect(html).toContain("Try again");
  });

  it("says counting hasn't started when there are no counts yet", () => {
    state.query = { ...state.query, data: list({ asOf: null, items: [] }) };
    expect(render()).toContain("Counting hasn't started yet.");
  });

  it("shows the on-chain group and the recorded group, each number with its date, parts and explorer link", () => {
    state.query = { ...state.query, data: list() };
    const html = render();
    expect(html).toContain("On Arc mainnet, anyone can check");
    expect(html).toContain("Recorded by ArcOS");
    expect(html.indexOf("On Arc mainnet")).toBeLessThan(html.indexOf("Recorded by ArcOS"));
    expect(html).toContain("Tokens created with Mint");
    expect(html).toContain("1,234");
    expect(html).toContain("12,345");
    expect(html).toContain("tabular-nums");
    expect(html).toContain("since 25 Sep 2026");
    expect(html).toContain("since 14 Oct 2026");
    expect(html).toContain("Standard 1,000 · Mintable 234");
    expect(html).toContain(`href="${FACTORY_LOGS}"`);
    expect(html).toContain("TokenFactory logs");
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("puts the on-chain counts in the first group and the server counts in the second", () => {
    state.query = { ...state.query, data: list() };
    const html = render();
    const server = html.indexOf("Recorded by ArcOS");
    expect(html.indexOf("Drop transactions")).toBeLessThan(server);
    expect(html.indexOf("Wallets signed in")).toBeGreaterThan(server);
  });

  it("leaves out a group with no counts", () => {
    state.query = { ...state.query, data: list({ items: list().items.filter((i) => i.source === "onchain") }) };
    const html = render();
    expect(html).toContain("On Arc mainnet, anyone can check");
    expect(html).not.toContain("Recorded by ArcOS");
  });

  it("ends with the block, how long ago, that it is automated, the notes, Copy JSON link and how they are counted", () => {
    state.query = { ...state.query, data: list() };
    const html = render();
    expect(html).toContain("As of block 24,012,345 · updated 5 min ago · automated count");
    expect(html).toContain("Drop counts rows, not unique wallets.");
    expect(html).toContain("Copy JSON link");
    expect(html).toContain("#how-stats-counts");
    expect(html).toContain("How these are counted");
  });

  it("says counting is catching up when it is far behind the chain, and not otherwise", () => {
    state.query = { ...state.query, data: list({ asOf: { block: 22_800_000, atMs: NOW, behind: 1_200_000 } }) };
    expect(render()).toContain("still catching up with the chain");
    state.query = { ...state.query, data: list({ asOf: { block: 24_012_345, atMs: NOW, behind: 1_999 } }) };
    expect(render()).not.toContain("catching up");
  });

  it("says catching up and a failed refresh in the one status line that is mounted before it has text", () => {
    state.query = { ...state.query, data: list({ asOf: { block: 22_800_000, atMs: NOW, behind: 1_200_000 } }), isRefetchError: true };
    const html = render();
    expect(html).toMatch(/role="status" aria-live="polite">Couldn't refresh the counts\. Showing the last ones\. The on-chain counts are still catching up/);
    // No other status element is rendered with its text already inside, except the copy-link line, which starts empty.
    expect(html.match(/role="status"/g)).toHaveLength(2);
    expect(html).toMatch(/role="status" aria-live="polite" class="text-muted"><\/span>/);
  });

  it("names each group by its heading", () => {
    state.query = { ...state.query, data: list() };
    const html = render();
    for (const title of ["On Arc mainnet, anyone can check", "Recorded by ArcOS"]) {
      const id = new RegExp(`<section aria-labelledby="([^"]+)"[^>]*><h3 id="([^"]+)"[^>]*>${title}</h3>`).exec(html);
      expect(id, title).not.toBeNull();
      expect(id?.[1]).toBe(id?.[2]);
    }
    expect(html).not.toContain("aria-label=");
  });

  it("keeps the last numbers and says so when a refresh failed", () => {
    state.query = { ...state.query, data: list(), isRefetchError: true };
    const html = render();
    expect(html).toContain("Couldn't refresh the counts. Showing the last ones.");
    expect(html).toContain("1,234");
  });

  it("shows no fee, no address and no per-wallet number", () => {
    state.query = { ...state.query, data: list() };
    const html = render();
    expect(html).not.toMatch(/fee/i);
    expect(html.replace(/https:\/\/[^"]+/g, "")).not.toMatch(/0x[0-9a-fA-F]{8}/);
  });

  it("calls the product ArcOS, never 4rc.OS", () => {
    state.query = { ...state.query, data: list() };
    expect(render()).not.toMatch(/4rc\.?OS/i);
  });
});
