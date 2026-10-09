// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WatchFetchError, type WatchItem, type WatchList } from "../api";

/**
 * The window's wiring, mounted in jsdom: what the token param, the form, a drop, a Remove click, Link Telegram, the
 * wait for the chat and Unlink do, over a stubbed `fetch` and a stubbed `window.open`. React Query is a stub that
 * answers what each test sets and whose setQueryData feeds the next render; the gates pass their children through,
 * and the session is a fixture this test moves. Nothing here reaches the network, and every address is a test fixture.
 */

type DropItem = { kind: string; address: string };
const state = vi.hoisted(() => ({
  data: undefined as WatchList | undefined,
  query: { isPending: false, isLoadingError: false, isRefetchError: false, error: null as unknown, refetch: async () => undefined },
  setQueryData: vi.fn<(key: unknown, next: unknown) => void>(),
  cancelQueries: vi.fn<(filters: unknown) => Promise<void>>(async () => undefined),
  removeQueries: vi.fn<(filters: unknown) => void>(),
  notify: vi.fn<(text: string, tone?: string) => void>(),
  open: vi.fn<(appId: string, params?: Record<string, string>) => boolean>(() => true),
  refresh: vi.fn(async () => undefined),
  telegram: "unlinked" as "linked" | "unlinked",
  trackEvent: vi.fn<(name: string, props?: Record<string, string | number>) => void>(),
  accepts: undefined as readonly string[] | undefined,
  drop: undefined as ((item: DropItem) => void) | undefined,
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ ...state.query, data: state.data }),
  useQueryClient: () => ({ setQueryData: state.setQueryData, cancelQueries: state.cancelQueries, removeQueries: state.removeQueries }),
  queryOptions: (o: unknown) => o,
}));
vi.mock("@arcos/shell", () => ({
  useDesktop: () => ({ open: state.open, notify: state.notify }),
  useDropTarget: (accepts: readonly string[] | undefined, onDrop: (item: DropItem) => void) => {
    state.accepts = accepts;
    state.drop = onDrop;
    return { over: false, props: {} };
  },
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
const THIRD = "0x3333333333333333333333333333333333333333";
const T_ME = "https://t.me/arcos_watchdog_bot?start=AbCdEfGhIjKlMnOpQrStUv";
const ME = "/api/auth/me";
const row = (token: string, symbol: string | null = "WDG"): WatchItem => ({ token, symbol, addedAt: "2026-10-09T12:00:00.000Z", latestAlert: null });
const list = (...watches: WatchItem[]): WatchList => ({ limit: 3, watches });
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const session = (telegram: "linked" | "unlinked") => json(200, { address: "0x1111111111111111111111111111111111111111", telegram });

type Call = { input: string; init: RequestInit | undefined };
const calls: Call[] = [];
/** What the routes answer, in turn; a promise holds the route's answer back until the test releases it. */
let answers: Array<Response | Promise<Response>> = [];
/** What /api/auth/me answers, while the window waits for the chat. */
let me: () => Response;
const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  calls.push({ input: String(input), init });
  if (String(input) === ME) return me();
  return answers.shift() ?? new Response("", { status: 500 });
});
const meCalls = () => calls.filter((c) => c.input === ME).length;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
let opened: ReturnType<typeof vi.spyOn>;

async function mount(params: Record<string, string> = {}) {
  await act(async () => root.render(createElement(WatchdogWindow, { winId: "w-1", params })));
}
const input = () => host.querySelector("input")!;
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === text)!;
const removeButton = (label: string) => host.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
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
const drop = (address: string) => act(async () => state.drop!({ kind: "token", address }));
const alertText = () => host.querySelector('[role="alert"]')?.textContent ?? null;
const setVisibility = (value: "visible" | "hidden") => Object.defineProperty(document, "visibilityState", { value, configurable: true });
const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
  vi.stubGlobal("fetch", fetchStub);
  opened = vi.spyOn(window, "open").mockImplementation(() => null);
  calls.length = 0;
  fetchStub.mockClear();
  answers = [];
  me = () => session("unlinked");
  state.data = list(row(TOKEN));
  state.query = { isPending: false, isLoadingError: false, isRefetchError: false, error: null, refetch: async () => undefined };
  state.telegram = "unlinked";
  state.accepts = undefined;
  state.drop = undefined;
  // The list a change writes is the list the next render shows, as React Query's own setQueryData would have it.
  state.setQueryData.mockReset().mockImplementation((_key, next) => {
    state.data = next as WatchList;
  });
  state.cancelQueries.mockClear();
  state.removeQueries.mockClear();
  state.notify.mockClear();
  state.open.mockClear();
  state.refresh.mockReset().mockImplementation(async () => undefined);
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

  it("focuses the prefilled form once the list has arrived, when the param came while the list was loading", async () => {
    // A fresh open from Inspector's button: the list is still loading, so there is no form to focus yet.
    state.data = undefined;
    state.query = { ...state.query, isPending: true };
    const params = { token: OTHER };
    await mount(params);
    expect(host.querySelector("input")).toBeNull();
    state.data = list(row(TOKEN));
    state.query = { ...state.query, isPending: false };
    await mount(params);
    expect(input().value).toBe(OTHER);
    expect(document.activeElement).toBe(input());
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("prefills and focuses again when the open window is handed the same token once more", async () => {
    await mount({ token: OTHER });
    await type("0x12");
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).not.toBe(input());
    // The shell stores a fresh params object on every open that carries params, the same token or not.
    await mount({ token: OTHER });
    expect(input().value).toBe(OTHER);
    expect(document.activeElement).toBe(input());
    expect(alertText()).toBeNull();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("prefills once per open: the same params object prefills nothing when the window mounts again under the gates", async () => {
    // The session cookie expired under the open window and the wallet signed in again, or it disconnected and came
    // back: the gates mount the body anew, with the params object the shell stored on the open. The token it carried
    // was prefilled (and watched, or cleared) already; the form comes back empty, and nothing takes the focus.
    const params = { token: OTHER };
    await mount(params);
    expect(input().value).toBe(OTHER);
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount(params);
    expect(input().value).toBe("");
    expect(document.activeElement).not.toBe(input());
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("drops the cached list when the window leaves the page, so the next wallet doesn't start from it", async () => {
    await mount();
    expect(state.removeQueries).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    root = createRoot(host);
    expect(state.removeQueries).toHaveBeenCalledTimes(1);
    expect(state.removeQueries).toHaveBeenCalledWith({ queryKey: ["watches"] });
  });

  it("refuses what isn't an address in the form itself, without a request, and names the complaint from the input", async () => {
    await mount();
    await type("0x12");
    await submit();
    expect(alertText()).toBe("That isn't an address.");
    expect(input().getAttribute("aria-invalid")).toBe("true");
    expect(input().getAttribute("aria-describedby")).toBe(host.querySelector('[role="alert"]')!.id);
    expect(fetchStub).not.toHaveBeenCalled();
    // Typing again clears the complaint.
    await type("0x123");
    expect(alertText()).toBeNull();
    expect(input().getAttribute("aria-invalid")).toBe("false");
    expect(input().hasAttribute("aria-describedby")).toBe(false);
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
    // A refresh still in flight is cancelled before the route's list is written, so it can't put the old list back.
    expect(state.cancelQueries).toHaveBeenCalledWith({ queryKey: ["watches"] });
    expect(state.cancelQueries.mock.invocationCallOrder[0]!).toBeLessThan(state.setQueryData.mock.invocationCallOrder[0]!);
    expect(state.trackEvent).toHaveBeenCalledWith("watch_add", { watches: 2 });
    expect(input().value).toBe("");
    expect(alertText()).toBeNull();
    expect(host.textContent).toContain("2 of 3 tokens watched.");
  });

  it("gives focus back to the input once Watch, clicked, has done its work", async () => {
    // Watch is disabled while the route answers, and a disabled button can't keep the focus a click or Enter gave it:
    // the browser drops it to the body (jsdom doesn't, and won't blur a disabled button either, so the test drops it
    // in the browser's place, through the input).
    const dropFocus = () => {
      input().focus();
      input().blur();
    };
    let release!: (res: Response) => void;
    answers = [new Promise<Response>((resolve) => (release = resolve))];
    await mount();
    await type(OTHER);
    button("Watch").focus();
    await click(button("Watch"));
    expect(button("Watch").disabled).toBe(true);
    dropFocus();
    expect(document.activeElement).toBe(document.body);
    await act(async () => release(json(201, { limit: 3, watches: [row(TOKEN), row(OTHER, "TWO")] })));
    expect(host.textContent).toContain("2 of 3 tokens watched.");
    expect(document.activeElement).toBe(input());

    // A refused add, too: the input, which the complaint names.
    answers = [new Promise<Response>((resolve) => (release = resolve))];
    await type(THIRD);
    button("Watch").focus();
    await click(button("Watch"));
    dropFocus();
    await act(async () => release(json(503, { error: "Watchdog isn't available right now." })));
    expect(alertText()).toBe("Watchdog isn't available right now.");
    expect(document.activeElement).toBe(input());

    // A visitor who tabbed elsewhere while the route was answering keeps their place.
    answers = [new Promise<Response>((resolve) => (release = resolve))];
    await type(THIRD);
    button("Watch").focus();
    await click(button("Watch"));
    button("Link Telegram").focus();
    await act(async () => release(json(201, { limit: 3, watches: [row(TOKEN), row(OTHER, "TWO"), row(THIRD, "THREE")] })));
    expect(document.activeElement).toBe(button("Link Telegram"));
  });

  it("shows the route's sentence when an add is refused, keeps the token in the form, and counts nothing", async () => {
    answers = [json(409, { error: "You can watch up to 3 tokens. Remove one to add another." })];
    await mount();
    await type(OTHER);
    await submit();
    expect(alertText()).toBe("You can watch up to 3 tokens. Remove one to add another.");
    expect(input().value).toBe(OTHER);
    // The limit says nothing against the address: the input is described by the sentence, but not marked invalid.
    expect(input().getAttribute("aria-describedby")).toBe(host.querySelector('[role="alert"]')!.id);
    expect(input().getAttribute("aria-invalid")).toBe("false");
    expect(state.setQueryData).not.toHaveBeenCalled();
    expect(state.trackEvent).not.toHaveBeenCalled();
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it("marks the input invalid when the route's 400 faults the address", async () => {
    answers = [json(400, { error: "That isn't a token on Arc mainnet." })];
    await mount();
    await type(OTHER);
    await submit();
    expect(alertText()).toBe("That isn't a token on Arc mainnet.");
    expect(input().getAttribute("aria-invalid")).toBe("true");
    expect(input().getAttribute("aria-describedby")).toBe(host.querySelector('[role="alert"]')!.id);
  });

  it("counts nothing when the wallet already watched the token (the route's 200)", async () => {
    answers = [json(200, { limit: 3, watches: [row(TOKEN)] })];
    await mount();
    await type(TOKEN);
    await submit();
    expect(state.setQueryData).toHaveBeenCalledTimes(1);
    expect(state.trackEvent).not.toHaveBeenCalled();
  });

  it("watches a dropped token by its address, and leaves focus where it was", async () => {
    answers = [json(201, { limit: 3, watches: [row(TOKEN), row(OTHER, "TWO")] })];
    await mount();
    expect(state.accepts).toEqual(["token"]);
    await drop(OTHER);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ token: OTHER });
    expect(host.textContent).toContain("2 of 3 tokens watched.");
    expect(document.activeElement).toBe(document.body);
  });

  it("keeps a token dropped while the list is still loading in the form, which shows it once the list has arrived", async () => {
    state.data = undefined;
    state.query = { ...state.query, isPending: true };
    await mount();
    expect(state.accepts).toEqual(["token"]);
    expect(host.querySelector("input")).toBeNull();
    await drop(OTHER);
    expect(fetchStub).not.toHaveBeenCalled();
    state.data = list(row(TOKEN));
    state.query = { ...state.query, isPending: false };
    await mount();
    expect(input().value).toBe(OTHER);
    expect(alertText()).toBeNull();
    expect(fetchStub).not.toHaveBeenCalled();

    // While the first load failed, too: the form shows the token once Retry has brought the list.
    state.data = undefined;
    state.query = { ...state.query, isLoadingError: true, error: new WatchFetchError(503) };
    await mount();
    expect(host.querySelector("input")).toBeNull();
    await drop(THIRD);
    state.data = list(row(TOKEN));
    state.query = { ...state.query, isLoadingError: false, error: null };
    await mount();
    expect(input().value).toBe(THIRD);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("keeps a token dropped while a change is under way in the form, for Watch to send", async () => {
    let release!: (res: Response) => void;
    answers = [new Promise<Response>((resolve) => (release = resolve))];
    await mount();
    await click(removeButton("Remove WDG 0x470f…b099"));
    expect(button("Watch").disabled).toBe(true);
    await drop(OTHER);
    expect(input().value).toBe(OTHER);
    expect(alertText()).toBeNull();
    expect(calls).toHaveLength(1);
    await act(async () => release(json(200, { limit: 3, watches: [] })));
    expect(button("Watch").disabled).toBe(false);
    expect(input().value).toBe(OTHER);
  });

  it("DELETEs a row from its Remove button and shows the list the route answered", async () => {
    answers = [json(200, { limit: 3, watches: [] })];
    await mount();
    await click(removeButton("Remove WDG 0x470f…b099"));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ input: `/api/watches/${TOKEN}`, init: { method: "DELETE", credentials: "same-origin" } });
    expect(state.setQueryData).toHaveBeenCalledWith(["watches"], { limit: 3, watches: [] });
    expect(state.notify).not.toHaveBeenCalled();
    expect(host.textContent).toContain("No tokens watched yet.");
  });

  it("moves focus from a removed row to the row in its place, to the last row, then to the form", async () => {
    state.data = list(row(TOKEN), row(OTHER, "TWO"), row(THIRD, "THREE"));
    await mount();
    const first = removeButton("Remove WDG 0x470f…b099");
    first.focus();
    expect(document.activeElement).toBe(first);
    answers = [json(200, { limit: 3, watches: [row(OTHER, "TWO"), row(THIRD, "THREE")] })];
    await click(first);
    expect(document.activeElement).toBe(removeButton("Remove TWO 0x2222…2222"));

    // The last row: focus goes to the row now last.
    const last = removeButton("Remove THREE 0x3333…3333");
    last.focus();
    answers = [json(200, { limit: 3, watches: [row(OTHER, "TWO")] })];
    await click(last);
    expect(document.activeElement).toBe(removeButton("Remove TWO 0x2222…2222"));

    // No row left: the add-token input.
    answers = [json(200, { limit: 3, watches: [] })];
    await click(removeButton("Remove TWO 0x2222…2222"));
    expect(document.activeElement).toBe(input());
  });

  it("returns focus to the row's button when a remove fails, and leaves it where a visitor moved it meanwhile", async () => {
    answers = [json(503, { error: "Watchdog isn't available right now." })];
    await mount();
    const remove = removeButton("Remove WDG 0x470f…b099");
    remove.focus();
    await click(remove);
    expect(document.activeElement).toBe(removeButton("Remove WDG 0x470f…b099"));

    // A visitor who tabbed to the input while the route was answering keeps their place.
    let release!: (res: Response) => void;
    answers = [new Promise<Response>((resolve) => (release = resolve))];
    await click(remove);
    input().focus();
    await act(async () => release(json(200, { limit: 3, watches: [] })));
    expect(document.activeElement).toBe(input());
  });

  it("says so in a toast when a remove fails", async () => {
    answers = [json(503, { error: "Watchdog isn't available right now." })];
    await mount();
    await click(removeButton("Remove WDG 0x470f…b099"));
    expect(state.notify).toHaveBeenCalledWith("Watchdog isn't available right now.", "warn");
    expect(state.setQueryData).not.toHaveBeenCalled();
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it("tells the gate once when the list answers 401, so the sign-in prompt comes back", async () => {
    // The cookie expired under the open window, or the wallet signed out elsewhere: the poll's refetch answers 401.
    const gone = new WatchFetchError(401);
    state.query = { ...state.query, isRefetchError: true, error: gone };
    await mount();
    expect(state.refresh).toHaveBeenCalledTimes(1);
    await mount();
    expect(state.refresh).toHaveBeenCalledTimes(1);
    // The next poll's 401 is a new error: the gate is told again, in case the first read answered nothing.
    state.query = { ...state.query, error: new WatchFetchError(401) };
    await mount();
    expect(state.refresh).toHaveBeenCalledTimes(2);
  });

  it("tells the gate nothing when the list fails some other way", async () => {
    state.query = { ...state.query, isRefetchError: true, error: new WatchFetchError(503) };
    await mount();
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it("tells the gate when a change answers 401", async () => {
    answers = [json(401, { error: "Not signed in." })];
    await mount();
    await type(OTHER);
    await submit();
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(alertText()).toBe("Not signed in.");

    answers = [json(401, { error: "Not signed in." })];
    await click(removeButton("Remove WDG 0x470f…b099"));
    expect(state.refresh).toHaveBeenCalledTimes(2);

    answers = [json(401, { error: "Not signed in." })];
    await click(button("Link Telegram"));
    expect(state.refresh).toHaveBeenCalledTimes(3);
    expect(opened).not.toHaveBeenCalled();
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
    // The button left the page: the anchor holds the focus it had, so the way in stays under the keyboard.
    expect(document.activeElement).toBe(again);
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

  it("while waiting, reads the session every 5 s, only while the tab is visible, and stops after 10 minutes", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    answers = [json(200, { url: T_ME })];
    await mount();
    await click(button("Link Telegram"));
    expect(meCalls()).toBe(0);

    await tick(5_000);
    expect(meCalls()).toBe(1);
    await tick(10_000);
    expect(meCalls()).toBe(3);
    // A session still unlinked moves nothing: the gate isn't asked, the window keeps waiting.
    expect(state.refresh).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Press Start");

    setVisibility("hidden");
    await tick(30_000);
    expect(meCalls()).toBe(3);
    setVisibility("visible");
    await tick(5_000);
    expect(meCalls()).toBe(4);

    // Ten minutes after the link was made, the code has expired: the window stops asking and offers the button again,
    // which takes the focus the anchor had as it left the page.
    expect(document.activeElement?.textContent).toBe("Open the link again");
    await tick(10 * 60_000);
    const after = meCalls();
    await tick(60_000);
    expect(meCalls()).toBe(after);
    expect(host.textContent).toContain("Link Telegram");
    expect(host.textContent).not.toContain("Press Start");
    expect(document.activeElement).toBe(button("Link Telegram"));
  });

  it("keeps waiting through a failed session read, and tells the gate only when the chat got linked", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    answers = [json(200, { url: T_ME })];
    await mount();
    await click(button("Link Telegram"));

    // One read out of the wait's hundred-odd fails (a 5xx, a 429 from another tab's reads): nothing changes.
    me = () => new Response("", { status: 503 });
    await tick(5_000);
    expect(meCalls()).toBe(1);
    expect(state.refresh).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Press Start");
    me = () => {
      throw new TypeError("offline");
    };
    await tick(5_000);
    expect(meCalls()).toBe(2);
    expect(state.refresh).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Press Start");

    // The chat pressed Start: the gate reads the session, and the linked view takes over.
    me = () => session("linked");
    await tick(5_000);
    expect(meCalls()).toBe(3);
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });

  it("tells the gate when the session read while waiting says signed out", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    answers = [json(200, { url: T_ME })];
    await mount();
    await click(button("Link Telegram"));
    me = () => json(401, { error: "Not signed in." });
    await tick(5_000);
    expect(state.refresh).toHaveBeenCalledTimes(1);
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

  it("DELETEs the link from Unlink, reads the session again, and hands the focus to Link Telegram", async () => {
    state.telegram = "linked";
    answers = [json(200, { telegram: "unlinked" })];
    // The gate's re-read says unlinked: the view it renders next has the Link Telegram button where Unlink was.
    state.refresh.mockImplementation(async () => {
      state.telegram = "unlinked";
    });
    await mount();
    button("Unlink").focus();
    await click(button("Unlink"));
    expect(calls[0]).toMatchObject({ input: "/api/telegram/link", init: { method: "DELETE", credentials: "same-origin" } });
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(alertText()).toBeNull();
    await mount();
    expect(host.textContent).toContain("Link Telegram");
    expect(document.activeElement).toBe(button("Link Telegram"));
  });

  it("leaves focus where a visitor moved it while Unlink was answering", async () => {
    state.telegram = "linked";
    let release!: (res: Response) => void;
    answers = [new Promise<Response>((resolve) => (release = resolve))];
    state.refresh.mockImplementation(async () => {
      state.telegram = "unlinked";
    });
    await mount();
    button("Unlink").focus();
    await click(button("Unlink"));
    input().focus();
    await act(async () => release(json(200, { telegram: "unlinked" })));
    await mount();
    expect(host.textContent).toContain("Link Telegram");
    expect(document.activeElement).toBe(input());
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
