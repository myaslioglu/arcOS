import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WatchItem, WatchList } from "../api";

// Each state of the window as static markup. The gates pass their children through and the session is a fixture;
// React Query is a stub that answers what each test sets. Static rendering runs no effects, so nothing here is
// fetched, opened or sent, and every address is a test fixture.
const state = vi.hoisted(() => ({
  opts: undefined as { queryKey?: unknown } | undefined,
  query: {
    isPending: false,
    isLoadingError: false,
    isRefetchError: false,
    error: null as unknown,
    data: undefined as WatchList | undefined,
    refetch: async () => undefined,
  },
  session: { address: "0x1111111111111111111111111111111111111111", telegram: "unlinked" as "linked" | "unlinked", refresh: async () => undefined, signOut: async () => ({ ok: true as const }) },
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (o: { queryKey?: unknown }) => {
    state.opts = o;
    return state.query;
  },
  useQueryClient: () => ({ setQueryData: () => undefined }),
  queryOptions: (o: unknown) => o,
}));
vi.mock("@arcos/shell", () => ({
  useDesktop: () => ({ open: () => true, notify: () => undefined }),
  useDropTarget: (accepts: string[] | undefined) => ({ over: false, props: { "data-accepts": accepts?.join(",") ?? "" } }),
}));
vi.mock("@/components/ConnectGate", () => ({
  ConnectGate: ({ children }: { children: unknown }) => createElement("div", { "data-gate": "connect" }, children as never),
}));
vi.mock("@/components/SignInGate", () => ({
  SignInGate: ({ children }: { children: unknown }) => createElement("div", { "data-gate": "sign-in" }, children as never),
  useSession: () => state.session,
}));

import WatchdogWindow from "../Window";

const TOKEN = "0x470f09ae20163d5e243f6530fb328912a8fcb099";
const OTHER = "0x2222222222222222222222222222222222222222";
const THIRD = "0x3333333333333333333333333333333333333333";
const LINK = `https://explorer.example/token/${TOKEN}`;
const EMPTY =
  "No tokens watched yet. Watchdog checks a token's owner, supply, pause state, implementation and deepest pool, and sends an alert when one of them changes. You can watch up to 3 tokens.";

const item = (over: Partial<WatchItem> = {}): WatchItem => ({
  token: TOKEN,
  symbol: "WDG",
  addedAt: "2026-10-09T12:00:00.000Z",
  latestAlert: { text: "WDG (0x470f…b099): paused at block 1,234,567", link: LINK },
  ...over,
});
/** React escapes an apostrophe in static markup; read it back as typed. */
const render = (params: Record<string, string> = {}) =>
  renderToStaticMarkup(createElement(WatchdogWindow, { winId: "w-1", params })).replaceAll("&#x27;", "'");
const listing = (watches: WatchItem[], limit = 3) => {
  state.query = { ...state.query, data: { limit, watches } };
};

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
  state.opts = undefined;
  state.query = { isPending: false, isLoadingError: false, isRefetchError: false, error: null, data: undefined, refetch: async () => undefined };
  state.session = { ...state.session, telegram: "unlinked" };
});
afterEach(() => vi.unstubAllEnvs());

describe("Watchdog", () => {
  it("on testnet says it runs on mainnet only, before any gate, and reads nothing", () => {
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "testnet");
    state.query = { ...state.query, isPending: true };
    const html = render();
    expect(html).toContain("Watchdog runs on Arc mainnet only.");
    expect(html).not.toContain("data-gate");
    expect(html).not.toContain("Loading your watches.");
    expect(state.opts).toBeUndefined();
  });

  it("puts the body inside the connect gate, then the sign-in gate", () => {
    listing([]);
    const html = render();
    expect(html).toMatch(/<div data-gate="connect"><div data-gate="sign-in">/);
    expect(state.opts?.queryKey).toEqual(["watches"]);
  });

  it("says it is loading, in a status region that is there before the text", () => {
    state.query = { ...state.query, isPending: true };
    let html = render();
    expect(html).toContain('role="status" aria-live="polite">Loading your watches.</p>');
    expect(html).not.toContain("Add a token");
    // No form yet, so no drop target: a drop's outcome would have nowhere to show.
    expect(html).toContain('data-accepts=""');

    state.query = { ...state.query, isPending: false };
    listing([]);
    html = render();
    expect(html).toContain('role="status" aria-live="polite"></p>');
    expect(html).not.toContain("Loading your watches.");
    expect(html).toContain('data-accepts="token"');
  });

  it("says when the list couldn't load, with a Retry button, and never the error's words", () => {
    state.query = { ...state.query, isLoadingError: true, error: new Error("SECRET-db") };
    const html = render();
    expect(html).toContain('role="alert"');
    expect(html).toContain("Watchdog isn't available right now. Try again in a minute.");
    expect(html).toContain(">Retry</button>");
    expect(html).not.toContain("SECRET-db");
    expect(html).not.toContain("Add a token");
    expect(html).not.toContain("Link Telegram");
  });

  it("says when nothing is watched yet, with the footer, the form and the Telegram ask", () => {
    listing([]);
    const html = render();
    expect(html).toContain(EMPTY);
    expect(html).toContain("0 of 3 tokens watched.");
    expect(html).toContain(">Add a token</label>");
    expect(html).toContain('placeholder="Token address (0x…)"');
    expect(html).toMatch(/<button type="submit"(?![^>]*disabled="")[^>]*>Watch<\/button>/);
    expect(html).not.toContain("Remove one to add another");
    expect(html).toContain("Alerts go to Telegram. Link a chat to receive them.");
    expect(html).toContain(">Link Telegram</button>");
    expect(html).not.toContain("Telegram linked.");
    expect(html).toContain('data-accepts="token"');
  });

  it("shows each row's symbol and short address, its newest alert as a link in a new tab, and a Remove button", () => {
    listing([item(), item({ token: OTHER, symbol: null, latestAlert: null })]);
    const html = render();
    expect(html).toContain('aria-label="Watched tokens"');
    expect(html).toContain(">WDG</span>");
    expect(html).toMatch(/<span class="font-mono[^"]*" title="0x470f09ae20163d5e243f6530fb328912a8fcb099">0x470f…b099<\/span>/);
    expect(html).toContain(`<a href="${LINK}" target="_blank" rel="noreferrer noopener"`);
    expect(html).toContain("WDG (0x470f…b099): paused at block 1,234,567</a>");
    // The button's name carries the address too: symbols aren't unique.
    expect(html).toContain('aria-label="Remove WDG 0x470f…b099"');
    // A token without a symbol is named by its short address, twice: once as the name, once in mono.
    expect(html).toContain(">0x2222…2222</span>");
    expect(html).toContain('aria-label="Remove 0x2222…2222"');
    expect(html).toContain("No changes seen yet.");
    expect(html).toContain("2 of 3 tokens watched.");
  });

  it("shows an alert without an https link as plain text", () => {
    listing([item({ latestAlert: { text: "WDG (0x470f…b099): unpaused at block 2", link: null } })]);
    const html = render();
    expect(html).toContain("WDG (0x470f…b099): unpaused at block 2</p>");
    expect(html).not.toContain("<a href");
  });

  it("disables Watch at the limit, with the limit sentence", () => {
    listing([item(), item({ token: OTHER }), item({ token: THIRD })]);
    const html = render();
    expect(html).toContain("3 of 3 tokens watched.");
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Watch<\/button>/);
    expect(html).toContain("You can watch up to 3 tokens. Remove one to add another.");
  });

  it("keeps the last list on a failed refresh, with a note", () => {
    listing([item()]);
    state.query = { ...state.query, isRefetchError: true, error: new Error("x") };
    const html = render();
    expect(html).toContain("Couldn't refresh the list. Showing the last one.");
    expect(html).toContain(">WDG</span>");
    expect(html).not.toContain("Retry");
  });

  it("says Telegram is linked, with an Unlink button, once the session says so", () => {
    listing([item()]);
    state.session = { ...state.session, telegram: "linked" };
    const html = render();
    expect(html).toContain('aria-label="Telegram"');
    expect(html).toContain("Telegram linked.");
    expect(html).toContain(">Unlink</button>");
    expect(html).not.toContain("Link Telegram");
    expect(html).not.toContain("Link a chat");
  });

  it("prefills the form from the token param and sends nothing: the form holds the token, the list is unchanged", () => {
    // Static rendering runs no effect, so the prefill itself is checked in window-wiring.test.ts; here, the param
    // reaches no request and no row: the window shows the token nowhere but, after the effect, in the form.
    listing([]);
    const html = render({ token: OTHER });
    expect(html).toContain(EMPTY);
    expect(html).toContain("0 of 3 tokens watched.");
    expect(html).not.toContain("0x2222…2222");
  });

  it("never names a score", () => {
    listing([item()]);
    expect(render()).not.toMatch(/\bscor/i);
  });
});
