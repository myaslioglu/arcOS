// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WatchItem, WatchList } from "../api";

/**
 * The window's wiring, mounted in jsdom: what the token param, the form, a Remove click, Link Telegram, the wait for
 * the chat and Unlink do, over a stubbed `fetch` and a stubbed `window.open`. React Query is a stub that records the
 * list a change writes; the gates pass their children through, and the session is a fixture this test moves.
 * Nothing here reaches the network, and every address is a test fixture.
 */

const state = vi.hoisted(() => ({
  data: undefined as WatchList | undefined,
  setQueryData: vi.fn<(key: unknown, next: unknown) => void>(),
  notify: vi.fn<(text: string, tone?: string) => void>(),
  open: vi.fn<(appId: string, params?: Record<string, string>) => boolean>(() => true),
  refresh: vi.fn(async () => undefined),
  telegram: "unlinked" as "linked" | "unlinked",
  trackEvent: vi.fn<(name: string, props?: Record<string, string | number>) => void>(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ isPending: false, isLoadingError: false, isRefetchError: false, error: null, data: state.data, refetch: async () => undefined }),
  useQueryClient: () => ({ setQueryData: state.setQueryData }),
  queryOptions: (o: unknown) => o,
}));
vi.mock("@arcos/shell", () => ({
  useDesktop: () => ({ open: state.open, notify: state.notify }),
  useDropTarget: () => ({ over: false, props: {} }),
}));
vi.mock("@/components/ConnectGate", () => ({ ConnectGate: ({ children }: { children: unknown }) => children }));
vi.mock("@/components/SignInGate", () => ({
  SignInGate: ({ children }: { children: unknown }) => children,
  useSession: () => ({ address: "0x1111111111111111111111111111111111111111", telegram: state.telegram, refresh: state.refresh, signOut: async () => ({ ok: true }) }),
}));
vi.mock("@/lib/analytics", () => ({ trackEvent: state.trackEvent }));

import WatchdogWindow from "../Window";

const TOKEN = "0x470f09ae20163d5e243f6530fb328912a8fcb099";
const OTHER = "0x2222222222222222222222222222222222222222";
const T_ME = "https://t.me/arcos_watchdog_bot?start=AbCdEfGhIjKlMnOpQrStUv";
const row = (token: string, symbol: string | null = "WDG"): WatchItem => ({ token, symbol, addedAt: "2026-10-09T12:00:00.000Z", latestAlert: null });
const list = (...watches: WatchItem[]): WatchList => ({ limit: 3, watches });
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Call = { input: string; init: RequestInit | undefined };
const calls: Call[] = [];
let answers: Response[] = [];
const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  calls.push({ input: String(input), init });
  return answers.shift() ?? new Response("", { status: 500 });
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
let opened: ReturnType<typeof vi.spyOn>;

async function mount(params: Record<string, string> = {}) {
  await act(async () => root.render(createElement(WatchdogWindow, { winId: "w-1", params })));
}
const input = () => host.querySelector("input")!;
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === text)!;
const click = (el: Element) => act(async () => (el as HTMLElement).click());
const type = (value: string) =>
  act(async () => {
    const el = input();
    // React listens to the native input event through its own value tracker: set the value the way a user would.
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const submit = () => act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
const alertText = () => host.querySelector('[role="alert"]')?.textContent ?? null;
const setVisibility = (value: "visible" | "hidden") => Object.defineProperty(document, "visibilityState", { value, configurable: true });

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
  vi.stubGlobal("fetch", fetchStub);
  opened = vi.spyOn(window, "open").mockImplementation(() => null);
  calls.length = 0;
  answers = [];
  state.data = list(row(TOKEN));
  state.telegram = "unlinked";
  state.setQueryData.mockClear();
  state.notify.mockClear();
  state.open.mockClear();
  state.refresh.mockClear();
  state.trackEvent.mockClear();
  setVisibility("visible");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  opened.mockRestore();
});

describe("Watchdog's window wiring", () => {
  it("prefills and focuses the form from the token param, and sends nothing", async () => {
    await mount({ token: OTHER });
    expect(input().value).toBe(OTHER);
    expect(document.activeElement).toBe(input());
    expect(fetchStub).not.toHaveBeenCalled();
    expect(state.setQueryData).not.toHaveBeenCalled();
    expect(alertText()).toBeNull();
  });

  it("refuses what isn't an address in the form itself, without a request", async () => {
    await mount();
    await type("0x12");
    await submit();
    expect(alertText()).toBe("That isn't an address.");
    expect(input().getAttribute("aria-invalid")).toBe("true");
    expect(fetchStub).not.toHaveBeenCalled();
    // Typing again clears the complaint.
    await type("0x123");
    expect(alertText()).toBeNull();
  });

  it("POSTs a typed address, shows the list the route answered, clears the form and counts the add", async () => {
    answers = [json(201, { limit: 3, watches: [row(TOKEN), row(OTHER, "TWO")] })];
    await mount();
    await type(` ${OTHER} `);
    await submit();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ input: "/api/watches", init: { method: "POST", credentials: "same-origin" } });
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ token: OTHER });
    expect(state.setQueryData).toHaveBeenCalledWith(["watches"], { limit: 3, watches: [row(TOKEN), row(OTHER, "TWO")] });
    expect(state.trackEvent).toHaveBeenCalledWith("watch_add", { watches: 2 });
    expect(input().value).toBe("");
    expect(alertText()).toBeNull();
  });

  it("shows the route's sentence when an add is refused, keeps the token in the form, and counts nothing", async () => {
    answers = [json(409, { error: "You can watch up to 3 tokens. Remove one to add another." })];
    await mount();
    await type(OTHER);
    await submit();
    expect(alertText()).toBe("You can watch up to 3 tokens. Remove one to add another.");
    expect(input().value).toBe(OTHER);
    expect(state.setQueryData).not.toHaveBeenCalled();
    expect(state.trackEvent).not.toHaveBeenCalled();
  });

  it("counts nothing when the wallet already watched the token (the route's 200)", async () => {
    answers = [json(200, { limit: 3, watches: [row(TOKEN)] })];
    await mount();
    await type(TOKEN);
    await submit();
    expect(state.setQueryData).toHaveBeenCalledTimes(1);
    expect(state.trackEvent).not.toHaveBeenCalled();
  });

  it("DELETEs a row from its Remove button and shows the list the route answered", async () => {
    answers = [json(200, { limit: 3, watches: [] })];
    await mount();
    await click(host.querySelector('button[aria-label="Remove WDG"]')!);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ input: `/api/watches/${TOKEN}`, init: { method: "DELETE", credentials: "same-origin" } });
    expect(state.setQueryData).toHaveBeenCalledWith(["watches"], { limit: 3, watches: [] });
    expect(state.notify).not.toHaveBeenCalled();
  });

  it("says so in a toast when a remove fails", async () => {
    answers = [json(503, { error: "Watchdog isn't available right now." })];
    await mount();
    await click(host.querySelector('button[aria-label="Remove WDG"]')!);
    expect(state.notify).toHaveBeenCalledWith("Watchdog isn't available right now.", "warn");
    expect(state.setQueryData).not.toHaveBeenCalled();
  });

  it("asks the route for a t.me link, opens it in a new tab without an opener, and waits for the chat", async () => {
    answers = [json(200, { url: T_ME, expiresAt: "2026-10-09T12:10:00.000Z" })];
    await mount();
    await click(button("Link Telegram"));
    expect(calls[0]).toMatchObject({ input: "/api/telegram/link", init: { method: "POST", credentials: "same-origin" } });
    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledWith(T_ME, "_blank", "noopener,noreferrer");
    expect(state.trackEvent).toHaveBeenCalledWith("telegram_link");
    expect(host.textContent).toContain("Press Start in the chat that opened. This link works for 10 minutes.");
    const again = [...host.querySelectorAll("a")].find((a) => a.textContent === "Open the link again")!;
    expect(again.getAttribute("href")).toBe(T_ME);
    expect(again.getAttribute("target")).toBe("_blank");
    expect(again.getAttribute("rel")).toBe("noreferrer noopener");
    expect(host.textContent).not.toContain("Link Telegram");
  });

  it("opens nothing when the link the route answered isn't on t.me, and says Telegram isn't available", async () => {
    answers = [json(200, { url: "https://t.me@evil.example/start" })];
    await mount();
    await click(button("Link Telegram"));
    expect(opened).not.toHaveBeenCalled();
    expect(state.trackEvent).not.toHaveBeenCalled();
    expect(alertText()).toBe("Telegram alerts aren't available right now.");
    expect(host.textContent).toContain("Link Telegram");
  });

  it("shows the route's sentence when the link is refused", async () => {
    answers = [json(429, { error: "Too many requests. Try again in 30 seconds." })];
    await mount();
    await click(button("Link Telegram"));
    expect(opened).not.toHaveBeenCalled();
    expect(alertText()).toBe("Too many requests. Try again in 30 seconds.");
  });

  it("while waiting, reads the session again every 5 s, only while the tab is visible, and stops after 10 minutes", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    answers = [json(200, { url: T_ME })];
    await mount();
    await click(button("Link Telegram"));
    expect(state.refresh).not.toHaveBeenCalled();

    await act(async () => void (await vi.advanceTimersByTimeAsync(5_000)));
    expect(state.refresh).toHaveBeenCalledTimes(1);
    await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)));
    expect(state.refresh).toHaveBeenCalledTimes(3);

    setVisibility("hidden");
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));
    expect(state.refresh).toHaveBeenCalledTimes(3);
    setVisibility("visible");
    await act(async () => void (await vi.advanceTimersByTimeAsync(5_000)));
    expect(state.refresh).toHaveBeenCalledTimes(4);

    // Ten minutes after the link was made, the code has expired: the window stops asking and offers the button again.
    await act(async () => void (await vi.advanceTimersByTimeAsync(10 * 60_000)));
    const after = state.refresh.mock.calls.length;
    await act(async () => void (await vi.advanceTimersByTimeAsync(60_000)));
    expect(state.refresh).toHaveBeenCalledTimes(after);
    expect(host.textContent).toContain("Link Telegram");
    expect(host.textContent).not.toContain("Press Start");
  });

  it("says Telegram linked, once, when the session says so while waiting", async () => {
    answers = [json(200, { url: T_ME })];
    await mount();
    await click(button("Link Telegram"));
    state.telegram = "linked";
    await mount();
    expect(state.notify).toHaveBeenCalledTimes(1);
    expect(state.notify).toHaveBeenCalledWith("Telegram linked.", "ok");
    expect(host.textContent).toContain("Telegram linked.");
    expect(button("Unlink")).toBeDefined();
    await mount();
    expect(state.notify).toHaveBeenCalledTimes(1);
  });

  it("says nothing when the session was linked from the start", async () => {
    state.telegram = "linked";
    await mount();
    expect(state.notify).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Telegram linked.");
  });

  it("DELETEs the link from Unlink and reads the session again", async () => {
    state.telegram = "linked";
    answers = [json(200, { telegram: "unlinked" })];
    await mount();
    await click(button("Unlink"));
    expect(calls[0]).toMatchObject({ input: "/api/telegram/link", init: { method: "DELETE", credentials: "same-origin" } });
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(alertText()).toBeNull();
  });

  it("shows the route's sentence when unlinking fails, and keeps the chat", async () => {
    state.telegram = "linked";
    answers = [json(503, { error: "Telegram alerts aren't available right now." })];
    await mount();
    await click(button("Unlink"));
    expect(state.refresh).not.toHaveBeenCalled();
    expect(alertText()).toBe("Telegram alerts aren't available right now.");
    expect(host.textContent).toContain("Telegram linked.");
  });
});
