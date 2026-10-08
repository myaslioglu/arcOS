import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RadarItem, RadarList } from "../feed";

// The window reads the list from React Query; these tests only need its answers. Nothing here reaches the network.
const state = vi.hoisted(() => ({
  opts: undefined as { queryKey?: unknown; enabled?: boolean } | undefined,
  query: {
    isPending: false,
    isLoadingError: false,
    isRefetchError: false,
    error: null as unknown,
    data: undefined as RadarList | undefined,
    dataUpdatedAt: 0,
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
vi.mock("@arcos/shell", () => ({
  useDesktop: () => ({ open: () => true }),
  dragSourceProps: (item: { address: string }) => ({ draggable: true, "data-drag": item.address }),
}));

import { RadarFetchError } from "../feed";
import RadarWindow, { radarView } from "../Window";

const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const TOKEN = "0x470f09ae20163d5e243f6530fb328912a8fcb099";
const NOTE =
  "Each token shows the checks Inspector ran on it: evidence, never a score. A listing is not an endorsement. Automated analysis, not investment advice.";
const OFF = { liquid: false, passing: false };
const ON = { liquid: true, passing: false };

const item = (over: Partial<RadarItem> = {}): RadarItem => ({
  address: TOKEN,
  symbol: "RDR",
  name: "Radar token",
  source: "v3",
  firstSeen: new Date(NOW - 5 * 60_000).toISOString(),
  firstSeenMs: NOW - 5 * 60_000,
  passed: 6,
  total: 9,
  bestPoolDepth: "2500000000",
  decimals: 18,
  launchpad: "Padlaunch",
  ...over,
});
/** React escapes an apostrophe in static markup; read it back as typed. */
const render = () => renderToStaticMarkup(createElement(RadarWindow, { winId: "w-1", params: {} })).replaceAll("&#x27;", "'");
const listing = (rows: RadarItem[], indexedAt: number | null = NOW - 60_000) => {
  state.query = { ...state.query, data: { rows, indexedAt } };
};

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
  state.opts = undefined;
  state.query = { isPending: false, isLoadingError: false, isRefetchError: false, error: null, data: undefined, dataUpdatedAt: NOW, refetch: async () => undefined };
});
afterEach(() => vi.unstubAllEnvs());

describe("radarView", () => {
  const base = { isPending: false, isLoadingError: false, isRefetchError: false, error: null, data: undefined };
  it("picks each state in order", () => {
    expect(radarView(false, { ...base, isPending: true }, OFF)).toBe("elsewhere");
    expect(radarView(true, { ...base, isLoadingError: true, error: new RadarFetchError(404) }, OFF)).toBe("elsewhere");
    expect(radarView(true, { ...base, isPending: true }, OFF)).toBe("loading");
    expect(radarView(true, { ...base, isLoadingError: true, error: new RadarFetchError(503) }, OFF)).toBe("down");
    expect(radarView(true, { ...base, isLoadingError: true, error: new RadarFetchError(500) }, OFF)).toBe("failed");
    expect(radarView(true, { ...base, isLoadingError: true, error: new RadarFetchError(null) }, OFF)).toBe("failed");
    expect(radarView(true, { ...base, isLoadingError: true, error: new TypeError("x") }, OFF)).toBe("failed");
    expect(radarView(true, { ...base, data: { rows: [], indexedAt: null } }, OFF)).toBe("first-run");
    expect(radarView(true, { ...base, data: { rows: [], indexedAt: NOW } }, OFF)).toBe("empty");
    expect(radarView(true, { ...base, data: { rows: [], indexedAt: NOW } }, ON)).toBe("no-match");
    expect(radarView(true, { ...base, data: { rows: [item()], indexedAt: NOW } }, OFF)).toBe("list");
    expect(radarView(true, { ...base, data: { rows: [item()], indexedAt: null } }, OFF)).toBe("list");
  });
});

describe("Radar", () => {
  it("on testnet says where Radar is, fetches nothing and shows no filters", () => {
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "testnet");
    state.query = { ...state.query, isPending: true };
    const html = render();
    expect(html).toContain("Radar lists tokens on Arc mainnet only. This site has no token index.");
    expect(html).toContain('href="https://4rcos.com/#app:radar"');
    expect(html).toContain("Open Radar on 4rcos.com");
    expect(html).not.toContain("Has liquidity");
    expect(html).not.toContain("Loading new tokens");
    expect(state.opts?.enabled).toBe(false);
    expect(html).toContain(NOTE);
  });

  it("says where Radar is when the route answers 404 too", () => {
    state.query = { ...state.query, isLoadingError: true, error: new RadarFetchError(404) };
    expect(render()).toContain("This site has no token index.");
  });

  it("shows the filters and says it is loading", () => {
    state.query = { ...state.query, isPending: true };
    const html = render();
    expect(html).toContain('aria-label="Filters"');
    expect(html).toContain("Has liquidity");
    expect(html).toContain("1,000 USDC or more");
    expect(html).toContain("At least 5 checks pass");
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Loading new tokens…");
    expect(state.opts?.enabled).toBe(true);
    expect(state.opts?.queryKey).toEqual(["radar", "all"]);
    expect(html).toContain(NOTE);
  });

  it("tells the index being down from any other failure, with a Try again button, and never the error's words", () => {
    state.query = { ...state.query, isLoadingError: true, error: Object.assign(new RadarFetchError(503), { message: "SECRET-db" }) };
    let html = render();
    expect(html).toContain('role="alert"');
    expect(html).toContain("The token index can't be read right now. Radar tries again in a minute.");
    expect(html).toContain(">Try again</button>");
    expect(html).not.toContain("SECRET-db");
    expect(html).toContain(NOTE);

    state.query = { ...state.query, isLoadingError: true, error: Object.assign(new TypeError("SECRET-db"), { status: undefined }) };
    html = render();
    expect(html).toContain("Couldn't load new tokens. Radar tries again in a minute.");
    expect(html).not.toContain("SECRET-db");
  });

  it("says the index hasn't run, that nothing is recorded, or that nothing matches", () => {
    listing([], null);
    let html = render();
    expect(html).toContain("No tokens recorded yet. The list fills as the index finds new tokens on Arc.");
    expect(html).not.toContain("New tokens may be missing");
    expect(html).toContain(NOTE);

    listing([], NOW - 60_000);
    html = render();
    expect(html).toContain("No tokens recorded yet.");
    expect(html).not.toContain("The list fills");
    expect(html).not.toContain("New tokens may be missing");
  });

  it("shows a row's symbol, address, checks, liquidity, source and launchpad, with the caption", () => {
    listing([item()]);
    const html = render();
    expect(html).toContain('aria-label="New tokens"');
    expect(html).toContain("Showing the newest 1.");
    expect(html).toContain("Double-click a token to inspect it, or drag it onto Inspector or Drop.");
    expect(html).toContain("RDR · 0x470f…b099");
    expect(html).toContain("Radar token");
    expect(html).toContain("6 of 9 checks pass");
    expect(html).toContain("Liquidity 2,500 USDC");
    expect(html).toContain(">Uniswap v3</span>");
    expect(html).toContain('title="Where the index first saw it"');
    expect(html).toContain(">Padlaunch</span>");
    expect(html).toContain('title="Launched through Padlaunch"');
    expect(html).toContain("5 min ago");
    expect(html).toContain('title="2026-10-08 11:55 UTC"');
    expect(html).toContain('aria-label="Inspect RDR"');
    expect(html).toContain(`data-drag="${TOKEN}"`);
    expect(html).not.toContain("New tokens may be missing");
    expect(html).toContain(NOTE);
  });

  it("fills in what a row doesn't have, and gives a row without decimals no drag data", () => {
    listing([item({ symbol: null, name: null, passed: null, total: null, bestPoolDepth: null, decimals: null, launchpad: null, source: "factory" })]);
    const html = render();
    expect(html).toContain("No symbol · 0x470f…b099");
    expect(html).toContain("Unnamed token");
    expect(html).toContain("Not checked yet");
    expect(html).toContain("No pool yet");
    expect(html).toContain(">4rc.OS</span>");
    expect(html).toContain('aria-label="Inspect 0x470f…b099"');
    expect(html).not.toContain("data-drag");
    expect(html).not.toContain("Launched through");
  });

  it("notes a stale index, and one that has never reported a run, above the list", () => {
    listing([item()], NOW - 11 * 60_000);
    let html = render();
    expect(html).toContain('role="status"');
    expect(html).toContain("The index last ran 11 min ago. New tokens may be missing.");

    listing([item()], null);
    html = render();
    expect(html).toContain("The index hasn't reported a run yet. New tokens may be missing.");

    listing([], NOW - 11 * 60_000);
    html = render();
    expect(html).toContain("The index last ran 11 min ago. New tokens may be missing.");
  });

  it("keeps the last list on a failed refresh, with a note", () => {
    listing([item()]);
    state.query = { ...state.query, isRefetchError: true, error: new RadarFetchError(503) };
    const html = render();
    expect(html).toContain("Couldn't refresh the list. Showing the last one.");
    expect(html).toContain("RDR · 0x470f…b099");
    expect(html).not.toContain("Try again");
  });

  it("never colours the checks, and names a score only to deny one", () => {
    listing([item({ passed: 0, total: 9 })]);
    const html = render();
    expect(html.replaceAll("never a score", "")).not.toMatch(/\bscor/i);
    expect(html).not.toMatch(/text-(danger|success|accent)[^"]*">\s*0 of 9/);
  });
});
