// @vitest-environment jsdom
import { StrictMode, act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WatchItem, WatchList } from "../api";

/**
 * The window over a real QueryClient, the one the desktop shares between every window and every wallet that signs
 * in on the page (providers/Web3Provider.tsx), with `fetch` stubbed: what the ["watches"] cache holds for the next
 * wallet, and what a refresh in flight does to a change. The gates pass their children through, and the session is
 * a fixture this test moves. Nothing here reaches the network, and every address is a test fixture.
 */

const state = vi.hoisted(() => ({
  address: "0x1111111111111111111111111111111111111111",
  refresh: vi.fn(async () => undefined),
}));
vi.mock("@arcos/shell", () => ({
  useDesktop: () => ({ open: () => true, notify: () => undefined }),
  useDropTarget: () => ({ over: false, props: {} }),
}));
vi.mock("@/components/ConnectGate", () => ({ ConnectGate: ({ children }: { children: unknown }) => children }));
vi.mock("@/components/SignInGate", () => ({
  SignInGate: ({ children }: { children: unknown }) => children,
  useSession: () => ({ address: state.address, telegram: "unlinked", refresh: state.refresh, signOut: async () => ({ ok: true }) }),
}));
vi.mock("@/lib/analytics", () => ({ trackEvent: () => undefined }));

import WatchdogWindow from "../Window";

const WALLET_A = "0x1111111111111111111111111111111111111111";
const WALLET_B = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x470f09ae20163d5e243f6530fb328912a8fcb099";
const OTHER = "0x3333333333333333333333333333333333333333";
const row = (token: string, symbol: string): WatchItem => ({ token, symbol, addedAt: "2026-10-09T12:00:00.000Z", latestAlert: null });
const list = (...watches: WatchItem[]): WatchList => ({ limit: 3, watches });
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** What each GET /api/watches answers, in turn (a promise holds one back), and what a DELETE answers. */
let gets: Array<Response | Promise<Response>> = [];
let deletes: Array<Response | Promise<Response>> = [];
const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const queue = init?.method === "DELETE" ? deletes : gets;
  return queue.shift() ?? new Response("", { status: 500 });
});
/** Lets the stubbed route's answer land and the window re-render. */
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
const held = () => {
  let release!: (res: Response) => void;
  const answer = new Promise<Response>((resolve) => (release = resolve));
  return {
    answer,
    release: async (res: Response) => {
      await act(async () => release(res));
      await settle();
    },
  };
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let client: QueryClient;
let root: Root;
let host: HTMLDivElement;

const tree = (strict = false) => {
  const page = createElement(QueryClientProvider, { client }, createElement(WatchdogWindow, { winId: "w-1", params: {} }));
  return strict ? createElement(StrictMode, null, page) : page;
};
const mount = (strict = false) => act(async () => root.render(tree(strict)));
const unmount = async () => {
  await act(async () => root.unmount());
  root = createRoot(host);
};
const removeButton = (label: string) => host.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
const names = () => [...host.querySelectorAll("li .font-medium")].map((el) => el.textContent);

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
  vi.stubGlobal("fetch", fetchStub);
  gets = [];
  deletes = [];
  state.address = WALLET_A;
  state.refresh.mockClear();
  client = new QueryClient();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Watchdog's window over the shared query cache", () => {
  it("shows the next wallet its own list, never the last wallet's cached one", async () => {
    // Wallet A signs in and sees its list.
    gets = [json(200, list(row(TOKEN, "A-ONE")))];
    await mount();
    await settle();
    expect(names()).toEqual(["A-ONE"]);
    expect(host.textContent).toContain("1 of 3 tokens watched.");

    // A signs out, or the connected account changes: the gates take the body down. B signs in within the cache's
    // five minutes, and the body mounts again: B's list is loading, and nothing of A's is on the page meanwhile.
    await unmount();
    state.address = WALLET_B;
    const b = held();
    gets = [b.answer];
    await mount();
    expect(host.textContent).toContain("Loading your watches.");
    expect(names()).toEqual([]);
    expect(host.textContent).not.toContain("A-ONE");
    expect(host.textContent).not.toContain("tokens watched");
    expect(host.querySelector('button[aria-label^="Remove"]')).toBeNull();

    await b.release(json(200, list(row(OTHER, "B-ONE"))));
    expect(names()).toEqual(["B-ONE"]);
  });

  it("doesn't show the next wallet the 401 the last poll answered, nor tell the gate of it again", async () => {
    // A's cookie expired under the open window: the list answers 401, the gate is told, and the body goes down.
    gets = [json(401, { error: "Not signed in." })];
    await mount();
    await settle();
    expect(host.textContent).toContain("Watchdog isn't available right now. Try again in a minute.");
    expect(state.refresh).toHaveBeenCalledTimes(1);

    // A signs in again (or B does): the window loads afresh, with no error to show and no stale 401 to report (the
    // cleanup dropped the entry; the hook would also reset a data-less error to loading as its refetch began).
    await unmount();
    const next = held();
    gets = [next.answer];
    await mount();
    expect(host.textContent).toContain("Loading your watches.");
    expect(host.textContent).not.toContain("isn't available");
    expect(host.querySelector("button")).toBeNull();
    expect(state.refresh).toHaveBeenCalledTimes(1);
    await next.release(json(200, list()));
    expect(host.textContent).toContain("No tokens watched yet.");
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps the list a change wrote when a refresh that was already in flight answers the list from before it", async () => {
    gets = [json(200, list(row(TOKEN, "ONE"), row(OTHER, "TWO")))];
    await mount();
    await settle();
    expect(names()).toEqual(["ONE", "TWO"]);

    // The window regained focus (or the minute ticked): a refresh is in flight when Remove is clicked. The DELETE
    // answers first, with the shorter list; the refresh then answers the list from before the delete.
    const stale = held();
    gets = [stale.answer];
    const refetch = client.refetchQueries({ queryKey: ["watches"] });
    deletes = [json(200, list(row(OTHER, "TWO")))];
    await act(async () => removeButton("Remove ONE 0x470f…b099").click());
    await settle();
    expect(names()).toEqual(["TWO"]);
    await stale.release(json(200, list(row(TOKEN, "ONE"), row(OTHER, "TWO"))));
    await refetch;
    await settle();
    expect(names()).toEqual(["TWO"]);
    expect(host.textContent).toContain("1 of 3 tokens watched.");
    expect(client.getQueryData(["watches"])).toEqual(list(row(OTHER, "TWO")));
  });

  it("follows a change after the development-only double mount, which runs the cache cleanup once in between", async () => {
    // React's StrictMode mounts, unmounts and mounts the body again: the cleanup drops the query while the hook's
    // observer still holds it. The hook rebuilds it, and a change's list reaches the page as it does in production.
    gets = [json(200, list(row(TOKEN, "ONE"))), json(200, list(row(TOKEN, "ONE")))];
    await mount(true);
    await settle();
    await settle();
    expect(names()).toEqual(["ONE"]);
    deletes = [json(200, list())];
    await act(async () => removeButton("Remove ONE 0x470f…b099").click());
    await settle();
    expect(host.textContent).toContain("No tokens watched yet.");
    expect(client.getQueryData(["watches"])).toEqual(list());
  });
});
