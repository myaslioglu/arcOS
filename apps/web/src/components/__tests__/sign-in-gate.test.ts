// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SignedIn } from "../SignInGate";

/**
 * The gate mounted in jsdom over a stubbed `fetch` and a wallet fixture the test moves: what it shows while the
 * session is read, what an account change in the wallet does to the app under it, how long a read may take, and the
 * sign-out path (review 1, Minor 4). Nothing here reaches the network, and every address is a test fixture.
 */

const wallet = vi.hoisted(() => ({ address: "0x1111111111111111111111111111111111111111" as string | undefined }));
vi.mock("wagmi", () => ({
  useConnection: () => ({ address: wallet.address }),
  useSignMessage: () => ({ mutateAsync: async () => "0x" }),
}));

import { SignInGate, useSession } from "../SignInGate";

const WALLET_A = "0x1111111111111111111111111111111111111111";
const WALLET_B = "0x2222222222222222222222222222222222222222";
const ME = "/api/auth/me";
const LOGOUT = "/api/auth/logout";
const FAILED = "Couldn't sign out. Try again.";
const UNAVAILABLE = "Sign-in isn't available right now. Try again later.";
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const session = (address: string) => json(200, { address, telegram: "unlinked" });
/** A session answer held back until the test releases it. */
const held = () => {
  let release!: (res: Response) => void;
  let fail!: (reason: unknown) => void;
  const answer = new Promise<Response>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { answer, release, fail };
};

type Call = { input: string; init: RequestInit | undefined };
const calls: Call[] = [];
/** What /api/auth/me answers, each time it is read. */
let me: () => Response | Promise<Response>;
/** What POST /api/auth/logout answers. */
let logout: () => Response;
const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  calls.push({ input: String(input), init });
  if (String(input) === ME) return me();
  if (String(input) === LOGOUT) return logout();
  return new Response("", { status: 500 });
});
const meCalls = () => calls.filter((c) => c.input === ME);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
/** The session the app under the gate saw last. */
let seen: SignedIn | undefined;

const Child = () => {
  const session = useSession();
  useEffect(() => {
    seen = session;
  });
  return createElement("p", null, `the app for ${session.address}`);
};
const mount = () => act(async () => root.render(createElement(SignInGate, null, createElement(Child))));
/** Lets a stubbed answer land and the gate re-render. */
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
const text = () => host.textContent!.replaceAll("’", "'");
const loading = () => host.querySelector('[aria-busy="true"]') !== null;
const alertText = () => host.querySelector('[role="alert"]')?.textContent ?? null;

beforeEach(() => {
  vi.stubGlobal("fetch", fetchStub);
  calls.length = 0;
  fetchStub.mockClear();
  wallet.address = WALLET_A;
  me = () => session(WALLET_A);
  logout = () => new Response(null, { status: 204 });
  seen = undefined;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SignInGate", () => {
  it("shows its loading view until the session is read, with the read bounded at 10 s", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const read = held();
    me = () => read.answer;
    await mount();
    expect(loading()).toBe(true);
    expect(text()).not.toContain("the app");
    expect(meCalls()).toHaveLength(1);
    // The read carries the cookie and gives up on its own: one that hangs can't hold the gate in any view for minutes.
    expect(meCalls()[0]!.init).toMatchObject({ credentials: "same-origin" });
    expect(meCalls()[0]!.init!.signal).toBeInstanceOf(AbortSignal);
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(10_000);

    await act(async () => read.release(session(WALLET_A)));
    await settle();
    expect(loading()).toBe(false);
    expect(text()).toContain(`the app for ${WALLET_A}`);
  });

  it("lands on 'unavailable' when the read times out", async () => {
    const read = held();
    me = () => read.answer;
    await mount();
    expect(loading()).toBe(true);
    // What `fetch` does when the signal's 10 s run out: the stub stands in for it.
    await act(async () => read.fail(new DOMException("The operation timed out.", "TimeoutError")));
    await settle();
    expect(loading()).toBe(false);
    expect(text()).toContain(UNAVAILABLE);
    expect(text()).not.toContain("the app");
  });

  it("takes the last wallet's app off the page the moment the account changes, before the read answers", async () => {
    await mount();
    await settle();
    expect(text()).toContain(`the app for ${WALLET_A}`);

    // A's app asks for a refresh (a Telegram link, say) and the read is still answering when the account changes.
    const stale = held();
    me = () => stale.answer;
    const refreshing = seen!.refresh();
    expect(meCalls()).toHaveLength(2);

    // The account changes to B: A's app leaves the page at once, with its buttons, while B's session is read.
    const next = held();
    me = () => next.answer;
    wallet.address = WALLET_B;
    await mount();
    expect(loading()).toBe(true);
    expect(text()).not.toContain("the app");
    expect(meCalls()).toHaveLength(3);
    expect(meCalls()[2]!.init!.signal).toBeInstanceOf(AbortSignal);

    // B's answer lands: the app is B's.
    await act(async () => next.release(session(WALLET_B)));
    await settle();
    expect(loading()).toBe(false);
    expect(text()).toContain(`the app for ${WALLET_B}`);

    // A's stale read answers last: it is the last wallet's, and sets nothing.
    await act(async () => stale.release(session(WALLET_A)));
    await refreshing;
    await settle();
    expect(text()).toContain(`the app for ${WALLET_B}`);
    expect(text()).not.toContain(WALLET_A);
  });

  it("shows the sign-in prompt to a wallet whose session is another's, or none", async () => {
    me = () => session(WALLET_B);
    await mount();
    await settle();
    expect(text()).toContain("Sign in to use alerts.");
    expect(text()).not.toContain("the app");

    me = () => json(401, { error: "Not signed in." });
    wallet.address = WALLET_B;
    await mount();
    await settle();
    expect(text()).toContain("Sign in to use alerts.");
  });

  it("says so when signing out fails, keeps the app, and hands the caller the result", async () => {
    await mount();
    await settle();
    expect(text()).toContain("the app");
    expect(alertText()).toBeNull();

    logout = () => json(500, { error: "x" });
    let outcome: unknown;
    await act(async () => {
      outcome = await seen!.signOut();
    });
    expect(outcome).toEqual({ ok: false, error: FAILED });
    expect(meCalls()).toHaveLength(1);
    expect(alertText()).toBe(FAILED);
    expect(text()).toContain(`the app for ${WALLET_A}`);
  });

  it("reads the session again after signing out, and hands the caller the result", async () => {
    await mount();
    await settle();
    me = () => json(401, { error: "Not signed in." });
    let outcome: unknown;
    await act(async () => {
      outcome = await seen!.signOut();
    });
    expect(outcome).toEqual({ ok: true });
    expect(calls.filter((c) => c.input === LOGOUT)[0]!.init).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(meCalls()).toHaveLength(2);
    expect(text()).toContain("Sign in to use alerts.");
    expect(text()).not.toContain("the app");
  });
});
