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
  refetch: vi.fn(async () => undefined),
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
const FOURTH = "0x4444444444444444444444444444444444444444";
const LIMIT = "You can watch up to 3 tokens. Remove one to add another.";
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
/** Lets a stubbed route's answer, and the read that follows it, land and the window re-render. */
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
/** How often the text is on the page. */
const count = (text: string) => host.textContent!.split(text).length - 1;

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
  vi.stubGlobal("fetch", fetchStub);
  opened = vi.spyOn(window, "open").mockImplementation(() => null);
  calls.length = 0;
  fetchStub.mockClear();
  answers = [];
  me = () => session("unlinked");
  state.data = list(row(TOKEN));
  state.refetch.mockClear();
  state.query = { isPending: false, isLoadingError: false, isRefetchError: false, error: null, refetch: state.refetch };
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
    answers = [json(409, { error: LIMIT })];
    await mount();
    await type(FOURTH);
    await submit();
    expect(alertText()).toBe(LIMIT);
    expect(input().value).toBe(FOURTH);
    // The limit says nothing against the address: the input is described by the sentence, but not marked invalid.
    expect(input().getAttribute("aria-describedby")).toBe(host.querySelector('[role="alert"]')!.id);
    expect(input().getAttribute("aria-invalid")).toBe("false");
    expect(state.setQueryData).not.toHaveBeenCalled();
    expect(state.trackEvent).not.toHaveBeenCalled();
    expect(state.refresh).not.toHaveBeenCalled();
    expect(state.notify).not.toHaveBeenCalled();
    // The limit moved under the window (another tab or device added a token): the list on screen, its footer and
    // the Watch button's state are stale, so the list is read again at once rather than on the minute's poll.
    expect(state.refetch).toHaveBeenCalledTimes(1);

    // The read brings the list to the limit. The route's sentence is the limit sentence word for word: it is on the
    // page once, as the alert, not again as the muted line under the disabled button.
    state.data = list(row(TOKEN), row(OTHER, "TWO"), row(THIRD, "THREE"));
    await mount();
    expect(button("Watch").disabled).toBe(true);
    expect(alertText()).toBe(LIMIT);
    expect(count(LIMIT)).toBe(1);

    // A Remove answers the complaint: the alert goes with the row, and Watch is enabled with nothing stale under it.
    answers = [json(200, { limit: 3, watches: [row(TOKEN), row(OTHER, "TWO")] })];
    await click(removeButton("Remove THREE 0x3333…3333"));
    expect(host.textContent).toContain("2 of 3 tokens watched.");
    expect(alertText()).toBeNull();
    expect(count(LIMIT)).toBe(0);
    expect(button("Watch").disabled).toBe(false);
    expect(input().value).toBe(FOURTH);

    // Only that complaint: what the form says against the address itself stands through a Remove.
    await type("0x12");
    await submit();
    expect(alertText()).toBe("That isn't an address.");
    answers = [json(200, { limit: 3, watches: [row(TOKEN)] })];
    await click(removeButton("Remove TWO 0x2222…2222"));
    expect(alertText()).toBe("That isn't an address.");
    expect(input().getAttribute("aria-invalid")).toBe("true");

    // Typing clears the complaint, and the muted limit sentence comes back once the list is at the limit again.
    state.data = list(row(TOKEN), row(OTHER, "TWO"), row(THIRD, "THREE"));
    await type("");
    expect(alertText()).toBeNull();
    expect(count(LIMIT)).toBe(1);
  });

  it("sends nothing for a drop at the limit: the token waits in the form under the limit sentence", async () => {
    state.data = list(row(TOKEN), row(OTHER, "TWO"), row(THIRD, "THREE"));
    await mount();
    expect(button("Watch").disabled).toBe(true);
    await drop(FOURTH);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(input().value).toBe(FOURTH);
    expect(alertText()).toBeNull();
    expect(count(LIMIT)).toBe(1);
    expect(state.refetch).not.toHaveBeenCalled();
  });

  it("keeps the limit sentence beside a complaint that isn't the limit's, when the list reaches the limit under it", async () => {
    // The route's 400 shows under the form at 1 of 3. Before the visitor types again, the minute's poll brings the
    // list to the limit (two tokens were added on the phone): Watch is disabled, and the muted sentence says why,
    // once, beside the complaint, which stands.
    answers = [json(400, { error: "That isn't a token on Arc mainnet." })];
    await mount();
    await type(OTHER);
    await submit();
    expect(alertText()).toBe("That isn't a token on Arc mainnet.");
    expect(count(LIMIT)).toBe(0);
    state.data = list(row(TOKEN), row(THIRD, "THREE"), row(FOURTH, "FOUR"));
    await mount();
    expect(button("Watch").disabled).toBe(true);
    expect(alertText()).toBe("That isn't a token on Arc mainnet.");
    expect(input().getAttribute("aria-invalid")).toBe("true");
    expect(count(LIMIT)).toBe(1);

    // The form's own complaint, too.
    state.data = list(row(TOKEN));
    await type("0x12");
    await submit();
    expect(alertText()).toBe("That isn't an address.");
    state.data = list(row(TOKEN), row(THIRD, "THREE"), row(FOURTH, "FOUR"));
    await mount();
    expect(alertText()).toBe("That isn't an address.");
    expect(count(LIMIT)).toBe(1);
  });

  it("drops a 409's complaint when a poll brings the list back under the limit", async () => {
    // Watch answers 409 and the read it asks for shows the list at the limit, with the complaint as the alert. A
    // token is then removed on another device: the minute's poll brings the list to 2 of 3, Watch is enabled, and
    // the alert that said to remove one goes with the limit; the token waits in the form for Watch to send.
    answers = [json(409, { error: LIMIT })];
    await mount();
    await type(FOURTH);
    await submit();
    expect(alertText()).toBe(LIMIT);
    state.data = list(row(TOKEN), row(OTHER, "TWO"), row(THIRD, "THREE"));
    await mount();
    expect(button("Watch").disabled).toBe(true);
    expect(count(LIMIT)).toBe(1);
    state.data = list(row(TOKEN), row(OTHER, "TWO"));
    await mount();
    expect(button("Watch").disabled).toBe(false);
    expect(alertText()).toBeNull();
    expect(count(LIMIT)).toBe(0);
    expect(input().value).toBe(FOURTH);
    expect(input().hasAttribute("aria-describedby")).toBe(false);

    // A complaint that isn't the limit's stands through the same move.
    answers = [json(400, { error: "That isn't a token on Arc mainnet." })];
    await submit();
    expect(alertText()).toBe("That isn't a token on Arc mainnet.");
    state.data = list(row(TOKEN), row(OTHER, "TWO"), row(THIRD, "THREE"));
    await mount();
    state.data = list(row(TOKEN), row(OTHER, "TWO"));
    await mount();
    expect(alertText()).toBe("That isn't a token on Arc mainnet.");
  });

  it("marks the input invalid when the route's 400 faults the address", async () => {
    answers = [json(400, { error: "That isn't a token on Arc mainnet." })];
    await mount();
    await type(OTHER);
    await submit();
    expect(alertText()).toBe("That isn't a token on Arc mainnet.");
    expect(input().getAttribute("aria-invalid")).toBe("true");
    expect(input().getAttribute("aria-describedby")).toBe(host.querySelector('[role="alert"]')!.id);
    // Nothing says the list is stale.
    expect(state.refetch).not.toHaveBeenCalled();
  });

  it("keeps a token the form was given while an add was under way, whether the add succeeded or was refused", async () => {
    // A is dropped on an empty form: its POST starts. Before it answers, Inspector hands B (the form shows B, focused).
    let release!: (res: Response) => void;
    answers = [new Promise<Response>((resolve) => (release = resolve))];
    await mount();
    await drop(OTHER);
    expect(input().value).toBe("");
    expect(button("Watch").disabled).toBe(true);
    await mount({ token: THIRD });
    expect(input().value).toBe(THIRD);
    expect(document.activeElement).toBe(input());
    // A's 201 arrives: the list shows A, and B stays in the form for Watch to send.
    await act(async () => release(json(201, { limit: 3, watches: [row(TOKEN), row(OTHER, "TWO")] })));
    expect(host.textContent).toContain("2 of 3 tokens watched.");
    expect(input().value).toBe(THIRD);
    expect(alertText()).toBeNull();
    expect(document.activeElement).toBe(input());

    // B is sent from the form and refused; A is dropped meanwhile, while a change is under way, so it waits in the
    // form. The refusal leaves A there: the token refused goes into the form only when the form is empty. The
    // complaint isn't about A, so it isn't under the form: it goes to a toast that names the token refused.
    answers = [new Promise<Response>((resolve) => (release = resolve))];
    await submit();
    expect(button("Watch").disabled).toBe(true);
    await drop(OTHER);
    expect(input().value).toBe(OTHER);
    await act(async () => release(json(503, { error: "Watchdog isn't available right now." })));
    expect(alertText()).toBeNull();
    expect(input().hasAttribute("aria-describedby")).toBe(false);
    expect(state.notify).toHaveBeenCalledWith("0x3333…3333: Watchdog isn't available right now.", "warn");
    expect(input().value).toBe(OTHER);
    expect(calls).toHaveLength(2);

    // Typed while the route answered, too: what was typed stays, on success and after a refusal alike, and a refusal
    // faults nothing the visitor typed.
    answers = [new Promise<Response>((resolve) => (release = resolve))];
    await type("");
    await drop(THIRD);
    expect(calls).toHaveLength(3);
    await type("0x12");
    await act(async () => release(json(409, { error: LIMIT })));
    expect(input().value).toBe("0x12");
    expect(alertText()).toBeNull();
    expect(input().getAttribute("aria-invalid")).toBe("false");
    expect(state.notify).toHaveBeenCalledWith(`0x3333…3333: ${LIMIT}`, "warn");
    expect(state.refetch).toHaveBeenCalledTimes(1);
    answers = [new Promise<Response>((resolve) => (release = resolve))];
    await type(THIRD);
    await submit();
    await type("0x34");
    await act(async () => release(json(201, { limit: 3, watches: [row(TOKEN), row(OTHER, "TWO"), row(THIRD, "THREE")] })));
    expect(input().value).toBe("0x34");

    // A route's 400 for a token dropped on an empty form, while Inspector handed another: the one in the form is
    // neither marked invalid nor described by a sentence about the other.
    state.data = list(row(TOKEN));
    state.notify.mockClear();
    answers = [new Promise<Response>((resolve) => (release = resolve))];
    await type("");
    await drop(OTHER);
    await mount({ token: FOURTH });
    expect(input().value).toBe(FOURTH);
    await act(async () => release(json(400, { error: "That isn't a token on Arc mainnet." })));
    expect(input().value).toBe(FOURTH);
    expect(alertText()).toBeNull();
    expect(input().getAttribute("aria-invalid")).toBe("false");
    expect(input().hasAttribute("aria-describedby")).toBe(false);
    expect(state.notify).toHaveBeenCalledTimes(1);
    expect(state.notify).toHaveBeenCalledWith("0x2222…2222: That isn't a token on Arc mainnet.", "warn");

    // A dropped token refused on an empty form goes into it, with the sentence, so the visitor sees what was refused;
    // a 400 then faults the address in the form, which is the one sent.
    state.notify.mockClear();
    await type("");
    answers = [json(409, { error: LIMIT })];
    await drop(OTHER);
    expect(input().value).toBe(OTHER);
    expect(alertText()).toBe(LIMIT);
    expect(input().getAttribute("aria-invalid")).toBe("false");
    await type("");
    answers = [json(400, { error: "That isn't a token on Arc mainnet." })];
    await drop(OTHER);
    expect(input().value).toBe(OTHER);
    expect(alertText()).toBe("That isn't a token on Arc mainnet.");
    expect(input().getAttribute("aria-invalid")).toBe("true");
    expect(state.notify).not.toHaveBeenCalled();
  });

  it("leaves a form the visitor emptied during the add empty, and shows the refusal without marking the field", async () => {
    // A is sent from the form; the visitor clears the field while the route answers. A's refusal is shown (it was
    // what they sent), but A doesn't come back into the field, and an empty field isn't marked invalid for it.
    let release!: (res: Response) => void;
    answers = [new Promise<Response>((resolve) => (release = resolve))];
    await mount();
    await type(OTHER);
    await submit();
    await type("");
    await act(async () => release(json(409, { error: LIMIT })));
    expect(input().value).toBe("");
    expect(alertText()).toBe(LIMIT);
    expect(input().getAttribute("aria-invalid")).toBe("false");
    expect(state.notify).not.toHaveBeenCalled();

    answers = [new Promise<Response>((resolve) => (release = resolve))];
    await type(OTHER);
    await submit();
    await type("");
    await act(async () => release(json(400, { error: "That isn't a token on Arc mainnet." })));
    expect(input().value).toBe("");
    expect(alertText()).toBe("That isn't a token on Arc mainnet.");
    expect(input().getAttribute("aria-invalid")).toBe("false");
    expect(input().getAttribute("aria-describedby")).toBe(host.querySelector('[role="alert"]')!.id);
    expect(state.notify).not.toHaveBeenCalled();
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

    // Unlink, too, straight away: there is no session left for the window to read first.
    state.telegram = "linked";
    await mount();
    answers = [json(401, { error: "Not signed in." })];
    await click(button("Unlink"));
    await settle();
    expect(state.refresh).toHaveBeenCalledTimes(4);
    expect(meCalls()).toBe(0);
    expect(alertText()).toBe("Not signed in.");
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

    const timeout = vi.spyOn(AbortSignal, "timeout");
    await tick(5_000);
    expect(meCalls()).toBe(1);
    // Each read gives up on its own, after the poll's interval (a hung one would otherwise hold every later read
    // back until it failed).
    expect(calls.find((c) => c.input === ME)!.init).toMatchObject({ credentials: "same-origin" });
    expect(calls.find((c) => c.input === ME)!.init!.signal).toBeInstanceOf(AbortSignal);
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(5_000);
    timeout.mockRestore();
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

    // A read that hangs holds the next ticks back only until it gives up (its signal's timeout, which the stub stands
    // in for by rejecting as the timeout would): the one after reads again.
    let giveUp!: (reason: unknown) => void;
    me = () => new Promise<Response>((_, reject) => (giveUp = reject)) as unknown as Response;
    await tick(5_000);
    expect(meCalls()).toBe(3);
    me = () => new Response("", { status: 503 });
    await tick(10_000);
    expect(meCalls()).toBe(3);
    await act(async () => giveUp(new DOMException("The operation timed out.", "TimeoutError")));
    await tick(5_000);
    expect(meCalls()).toBe(4);
    expect(state.refresh).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Press Start");

    // The chat pressed Start: the gate reads the session, and the linked view takes over.
    me = () => session("linked");
    await tick(5_000);
    expect(meCalls()).toBe(5);
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

  it("reads once more at the cutoff, hidden or not, and keeps waiting for the gate when the chat got linked meanwhile", async () => {
    // The link itself hides the tab (the t.me tab, or Telegram on the phone, takes its place): no tick reads while
    // it is. Start is pressed at minute 1 and the tab comes back at minute 11: the cutoff tick reads once, hidden or
    // not, and finds the chat linked. The gate is told and the wait stands, so the ask doesn't come back for a chat
    // that already gets the alerts (a press would spend a code to link it again), and the linked view, when the
    // gate's answer lands, says so once.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    answers = [json(200, { url: T_ME })];
    await mount();
    await click(button("Link Telegram"));
    setVisibility("hidden");
    me = () => session("linked");
    await tick(9 * 60_000 + 55_000);
    expect(meCalls()).toBe(0);
    await tick(5_000);
    expect(meCalls()).toBe(1);
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Press Start");
    expect(host.textContent).not.toContain("Link Telegram");
    // Until the gate has answered, the ticks read on.
    await tick(5_000);
    expect(meCalls()).toBe(2);
    expect(state.refresh).toHaveBeenCalledTimes(2);
    state.telegram = "linked";
    await mount();
    expect(host.textContent).toContain("Telegram linked.");
    expect(button("Unlink")).toBeDefined();
    expect(state.notify).toHaveBeenCalledTimes(1);
    expect(state.notify).toHaveBeenCalledWith("Telegram linked.", "ok");
    await tick(60_000);
    expect(meCalls()).toBe(2);
    expect(state.notify).toHaveBeenCalledTimes(1);
  });

  it("ends the wait at the cutoff when the last read says unlinked, or fails", async () => {
    // Start was never pressed: the last read says so, and the ask comes back, as it does when that read fails (the
    // phone is offline): the chat may be linked, and a press of Link Telegram makes a new code.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    answers = [json(200, { url: T_ME })];
    await mount();
    await click(button("Link Telegram"));
    setVisibility("hidden");
    await tick(10 * 60_000);
    expect(meCalls()).toBe(1);
    expect(state.refresh).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Link Telegram");
    expect(host.textContent).not.toContain("Press Start");
    await tick(60_000);
    expect(meCalls()).toBe(1);

    setVisibility("visible");
    answers = [json(200, { url: T_ME })];
    await click(button("Link Telegram"));
    me = () => new Response("", { status: 503 });
    setVisibility("hidden");
    await tick(10 * 60_000);
    expect(meCalls()).toBe(2);
    expect(state.refresh).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Link Telegram");
    expect(alertText()).toBeNull();
  });

  it("says Telegram linked, once, when the session says so while waiting, and hands the focus to Unlink", async () => {
    answers = [json(200, { url: T_ME })];
    await mount();
    await click(button("Link Telegram"));
    // The anchor took the focus the button had; the visitor came back from the Telegram tab with it still there.
    expect(document.activeElement?.textContent).toBe("Open the link again");
    state.telegram = "linked";
    await mount();
    expect(state.notify).toHaveBeenCalledTimes(1);
    expect(state.notify).toHaveBeenCalledWith("Telegram linked.", "ok");
    expect(host.textContent).toContain("Telegram linked.");
    expect(button("Unlink")).toBeDefined();
    // The anchor left the page: Unlink takes the focus, so a keyboard user keeps their place.
    expect(document.activeElement).toBe(button("Unlink"));
    await mount();
    expect(state.notify).toHaveBeenCalledTimes(1);
  });

  it("leaves focus where a visitor moved it while the chat got linked", async () => {
    answers = [json(200, { url: T_ME })];
    await mount();
    await click(button("Link Telegram"));
    input().focus();
    state.telegram = "linked";
    await mount();
    expect(host.textContent).toContain("Telegram linked.");
    expect(document.activeElement).toBe(input());
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
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await click(button("Unlink"));
    await settle();
    expect(calls[0]).toMatchObject({ input: "/api/telegram/link", init: { method: "DELETE", credentials: "same-origin" } });
    // The window reads the session itself first, with the poll's timeout, and tells the gate once the read answered.
    expect(calls[1]).toMatchObject({ input: ME, init: { credentials: "same-origin" } });
    expect(calls[1]!.init!.signal).toBeInstanceOf(AbortSignal);
    expect(timeout).toHaveBeenCalledWith(5_000);
    timeout.mockRestore();
    expect(calls).toHaveLength(2);
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(alertText()).toBeNull();
    await mount();
    expect(host.textContent).toContain("Link Telegram");
    expect(document.activeElement).toBe(button("Link Telegram"));
  });

  it("releases Unlink as soon as the route has answered, and flips the view when the session read lands", async () => {
    // The DELETE answers 200 (the chat is gone server-side), then the read of the session hangs: the phone's
    // connection dropped. The button is enabled again at once rather than for as long as the read takes, the view
    // says what the gate still holds, and the gate isn't told: its own re-read, failing, would show its "unavailable"
    // view in the body's place.
    state.telegram = "linked";
    answers = [json(200, { telegram: "unlinked" })];
    let land!: (res: Response) => void;
    me = () => new Promise<Response>((resolve) => (land = resolve)) as unknown as Response;
    state.refresh.mockImplementation(async () => {
      state.telegram = "unlinked";
    });
    await mount();
    button("Unlink").focus();
    await click(button("Unlink"));
    await settle();
    expect(meCalls()).toBe(1);
    expect(button("Unlink").disabled).toBe(false);
    expect(host.textContent).toContain("Telegram linked.");
    expect(state.refresh).not.toHaveBeenCalled();
    expect(alertText()).toBeNull();

    // The read lands: the gate is told, the view flips, and Link Telegram takes the focus Unlink had.
    await act(async () => land(session("unlinked")));
    await settle();
    expect(state.refresh).toHaveBeenCalledTimes(1);
    await mount();
    expect(host.textContent).toContain("Link Telegram");
    expect(document.activeElement).toBe(button("Link Telegram"));
  });

  it("keeps the window when the session read after Unlink fails, says so, and hands the focus back to Unlink", async () => {
    // The DELETE answers 200 (the chat is gone server-side); the window's own read of the session fails (a 503, or
    // the 5 s timeout). The gate isn't told (its re-read, failing, would take the body away), the list and the form
    // stay, and the section says the unlink couldn't be confirmed, with Unlink to press again. Unlink was disabled
    // while the route answered and couldn't keep the focus it had (the test drops it in the browser's place, through
    // the input): enabled again, it takes the focus back.
    state.telegram = "linked";
    let release!: (res: Response) => void;
    answers = [new Promise<Response>((resolve) => (release = resolve)), json(200, { telegram: "unlinked" })];
    me = () => new Response("", { status: 503 });
    await mount();
    button("Unlink").focus();
    await click(button("Unlink"));
    expect(button("Unlink").disabled).toBe(true);
    input().focus();
    input().blur();
    expect(document.activeElement).toBe(document.body);
    await act(async () => release(json(200, { telegram: "unlinked" })));
    await settle();
    expect(meCalls()).toBe(1);
    expect(state.refresh).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Telegram linked.");
    expect(button("Unlink").disabled).toBe(false);
    expect(alertText()).toBe("Couldn't confirm the unlink. Press Unlink again.");
    expect(host.querySelector("input")).not.toBeNull();
    expect(document.activeElement).toBe(button("Unlink"));

    // Pressed again: the route answers 200 again (there is no chat to take away), and this time the read answers:
    // the sentence goes, and the gate is told.
    me = () => session("unlinked");
    await click(button("Unlink"));
    await settle();
    expect(meCalls()).toBe(2);
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(alertText()).toBeNull();
  });

  it("leaves focus where a visitor moved it while the session read after Unlink was failing", async () => {
    state.telegram = "linked";
    answers = [json(200, { telegram: "unlinked" })];
    let fail!: (reason: unknown) => void;
    me = () => new Promise<Response>((_, reject) => (fail = reject)) as unknown as Response;
    await mount();
    button("Unlink").focus();
    await click(button("Unlink"));
    await settle();
    expect(meCalls()).toBe(1);
    input().focus();
    await act(async () => fail(new DOMException("The operation timed out.", "TimeoutError")));
    await settle();
    expect(alertText()).toBe("Couldn't confirm the unlink. Press Unlink again.");
    expect(document.activeElement).toBe(input());
  });

  it("lets a second Unlink press take over from the first, whose late read then says nothing", async () => {
    // Unlink is pressed: the DELETE answers 200, the button is released (no read holds it) and the read that would
    // flip the view hangs. Nothing on the page says so, and Unlink is pressed again: a second DELETE (200), a second
    // read, which answers unlinked. The gate is told and the view flips. The first read then gives up (readSession's
    // 5 s): the press it belongs to is over, so it sets no "Press Unlink again." under the Link Telegram view, where
    // there is no Unlink to press.
    const reads: Array<{ resolve: (res: Response) => void; reject: (reason: unknown) => void }> = [];
    me = () => new Promise<Response>((resolve, reject) => reads.push({ resolve, reject })) as unknown as Response;
    const giveUp = (read: { reject: (reason: unknown) => void }) => act(async () => read.reject(new DOMException("The operation timed out.", "TimeoutError")));
    const pressTwice = async () => {
      state.telegram = "linked";
      state.refresh.mockReset().mockImplementation(async () => {
        state.telegram = "unlinked";
      });
      answers = [json(200, { telegram: "unlinked" }), json(200, { telegram: "unlinked" })];
      reads.length = 0;
      await mount();
      await click(button("Unlink"));
      await settle();
      expect(button("Unlink").disabled).toBe(false);
      await click(button("Unlink"));
      await settle();
      expect(reads).toHaveLength(2);
      expect(calls.filter((c) => c.input === "/api/telegram/link")).toHaveLength(calls.filter((c) => c.input === ME).length);
    };
    await pressTwice();
    await act(async () => reads[1]!.resolve(session("unlinked")));
    await settle();
    expect(state.refresh).toHaveBeenCalledTimes(1);
    await mount();
    expect(host.textContent).toContain("Link Telegram");
    await giveUp(reads[0]!);
    await settle();
    expect(alertText()).toBeNull();
    expect(host.textContent).toContain("Link Telegram");
    expect(host.textContent).not.toContain("Press Unlink again");
    expect(state.refresh).toHaveBeenCalledTimes(1);

    // The other order: the first read answers unlinked, the second fails. The first press is over, so its answer
    // tells no gate; the second press's read failing says the unlink couldn't be confirmed, under the linked view
    // with its Unlink to press again, and a third press reads again and tells the gate.
    await act(async () => root.unmount());
    root = createRoot(host);
    calls.length = 0;
    await pressTwice();
    await act(async () => reads[0]!.resolve(session("unlinked")));
    await settle();
    expect(state.refresh).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Telegram linked.");
    await giveUp(reads[1]!);
    await settle();
    expect(alertText()).toBe("Couldn't confirm the unlink. Press Unlink again.");
    expect(host.textContent).toContain("Telegram linked.");
    expect(button("Unlink").disabled).toBe(false);
    answers = [json(200, { telegram: "unlinked" })];
    me = () => session("unlinked");
    await click(button("Unlink"));
    await settle();
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(alertText()).toBeNull();
    await mount();
    expect(host.textContent).toContain("Link Telegram");
  });

  it("acts on nothing when a Telegram route answers after the section has left the page", async () => {
    // Link Telegram is pressed and, while the route answers, the window is closed (or the gates take the body down:
    // the wallet signed out or changed). The 200 then opens no tab for a window that is gone, counts no link the
    // visitor never saw, and a 401 tells no gate: a refresh for a section that has gone is a read the page didn't ask for.
    let release!: (res: Response) => void;
    answers = [new Promise<Response>((resolve) => (release = resolve))];
    await mount();
    await click(button("Link Telegram"));
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => release(json(200, { url: T_ME })));
    await settle();
    expect(opened).not.toHaveBeenCalled();
    expect(state.trackEvent).not.toHaveBeenCalled();
    expect(state.refresh).not.toHaveBeenCalled();

    answers = [new Promise<Response>((resolve) => (release = resolve))];
    await mount();
    await click(button("Link Telegram"));
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => release(json(401, { error: "Not signed in." })));
    await settle();
    expect(state.refresh).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();

    // Unlink, too: a 401 tells no gate, and a 200 reads no session (a read for a section that has gone).
    state.telegram = "linked";
    answers = [new Promise<Response>((resolve) => (release = resolve))];
    await mount();
    await click(button("Unlink"));
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => release(json(401, { error: "Not signed in." })));
    await settle();
    expect(state.refresh).not.toHaveBeenCalled();
    expect(meCalls()).toBe(0);

    answers = [new Promise<Response>((resolve) => (release = resolve))];
    await mount();
    await click(button("Unlink"));
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => release(json(200, { telegram: "unlinked" })));
    await settle();
    expect(meCalls()).toBe(0);
    expect(state.refresh).not.toHaveBeenCalled();

    // The section mounted again (the next wallet, or the window opened again) is untouched by any of it.
    state.telegram = "unlinked";
    await mount();
    expect(host.textContent).toContain("Link Telegram");
    expect(alertText()).toBeNull();
    expect(calls).toHaveLength(4);
  });

  it("opens nothing and says nothing when the chat got linked while Link Telegram's route was answering", async () => {
    // The gate's session flips to linked while the POST is out (the poll told the gate at the end of a wait, and
    // the gate's own read landed only now; or the chat was linked on another device): the section is in its linked
    // view, with Unlink enabled, by the time the route answers, and the answer is for a press that is over. No tab
    // opens for a chat already linked, no telegram_link is counted, no wait begins under the linked view, and
    // "Telegram linked." isn't said for it.
    let release!: (res: Response) => void;
    answers = [new Promise<Response>((resolve) => (release = resolve))];
    await mount();
    await click(button("Link Telegram"));
    expect(button("Link Telegram").disabled).toBe(true);
    state.telegram = "linked";
    await mount();
    expect(host.textContent).toContain("Telegram linked.");
    expect(button("Unlink").disabled).toBe(false);
    expect(state.notify).not.toHaveBeenCalled();
    await act(async () => release(json(200, { url: T_ME })));
    await settle();
    expect(opened).not.toHaveBeenCalled();
    expect(state.trackEvent).not.toHaveBeenCalled();
    expect(state.notify).not.toHaveBeenCalled();
    expect(alertText()).toBeNull();
    expect(button("Unlink").disabled).toBe(false);

    // Unlink then: no wait was begun, so the ask comes back, not "Press Start" for a link never opened.
    answers = [json(200, { telegram: "unlinked" })];
    me = () => session("unlinked");
    state.refresh.mockImplementation(async () => {
      state.telegram = "unlinked";
    });
    await click(button("Unlink"));
    await settle();
    await mount();
    expect(host.textContent).toContain("Link Telegram");
    expect(host.textContent).not.toContain("Press Start");
    expect(alertText()).toBeNull();
  });

  it("drops a button's complaint, and a wait, when the view moves on without it", async () => {
    // The route refused the link (a 429) and its sentence stands under Link Telegram. The chat is then linked on
    // another device and the gate's session flips: the sentence was that button's, which left the page.
    answers = [json(429, { error: "Too many requests. Try again in 30 seconds." })];
    await mount();
    await click(button("Link Telegram"));
    expect(alertText()).toBe("Too many requests. Try again in 30 seconds.");
    state.telegram = "linked";
    await mount();
    expect(alertText()).toBeNull();
    expect(host.textContent).toContain("Telegram linked.");

    // A wait, too, ends with the linked view: the chat pressed Start (the toast), then was taken away on another
    // device. The ask comes back, not "Press Start" for a code that is spent.
    state.telegram = "unlinked";
    answers = [json(200, { url: T_ME })];
    await mount();
    await click(button("Link Telegram"));
    expect(host.textContent).toContain("Press Start");
    state.telegram = "linked";
    await mount();
    expect(state.notify).toHaveBeenCalledWith("Telegram linked.", "ok");
    state.telegram = "unlinked";
    await mount();
    expect(host.textContent).toContain("Link Telegram");
    expect(host.textContent).not.toContain("Press Start");
    expect(fetchStub).toHaveBeenCalledTimes(2);
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
    await settle();
    await mount();
    expect(host.textContent).toContain("Link Telegram");
    expect(document.activeElement).toBe(input());
  });

  it("shows the route's sentence when unlinking fails, and keeps the chat", async () => {
    state.telegram = "linked";
    answers = [json(503, { error: "Telegram alerts aren't available right now." })];
    await mount();
    await click(button("Unlink"));
    await settle();
    expect(state.refresh).not.toHaveBeenCalled();
    expect(meCalls()).toBe(0);
    expect(alertText()).toBe("Telegram alerts aren't available right now.");
    expect(host.textContent).toContain("Telegram linked.");
    expect(button("Unlink").disabled).toBe(false);
  });
});
