import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SignedIn } from "../SignInGate";

// SignInGate's sign-out path (review 1, Minor 4). Static rendering runs no effects and keeps no state, so the gate's one
// useState is replaced by a slot the test fills and reads: each render starts from `gate.state`, and whatever the gate
// sets lands in `gate.set`. Everything else (context, callbacks) is React's own. Nothing here reaches the network.
const gate = vi.hoisted(() => ({ state: undefined as unknown, set: undefined as unknown as ReturnType<typeof vi.fn> }));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react, useState: () => [gate.state, gate.set] };
});
vi.mock("wagmi", () => ({
  useAccount: () => ({ address: "0x1111111111111111111111111111111111111111" }),
  useSignMessage: () => ({ signMessageAsync: async () => "0x" }),
}));
const client = vi.hoisted(() => ({
  signOut: vi.fn(),
  fetchSession: vi.fn(),
}));
vi.mock("@/lib/sign-in-client", () => ({
  signOut: client.signOut,
  fetchSession: client.fetchSession,
  signInWithWallet: vi.fn(),
}));

const { SignInGate, useSession } = await import("../SignInGate");

const SESSION = { address: "0x1111111111111111111111111111111111111111", telegram: "unlinked" as const };
const FAILED = "Couldn't sign out. Try again.";

/** Renders the gate from `state` and answers its markup and the session its children saw. */
function render(state: unknown): { html: string; session: SignedIn } {
  gate.state = state;
  let seen: SignedIn | undefined;
  const Child = () => {
    seen = useSession();
    return createElement("p", null, "the app");
  };
  const html = renderToStaticMarkup(createElement(SignInGate, null, createElement(Child))).replaceAll("&#x27;", "'");
  return { html, session: seen! };
}

beforeEach(() => {
  gate.set = vi.fn();
  client.signOut.mockReset();
  client.fetchSession.mockReset();
});

describe("SignInGate sign-out", () => {
  it("says so when signing out fails, keeps the app, and hands the caller the result", async () => {
    client.signOut.mockResolvedValue({ ok: false, error: FAILED });
    const { html, session } = render({ kind: "signed-in", session: SESSION });
    expect(html).toContain("the app");
    expect(html).not.toContain(FAILED);

    await expect(session.signOut()).resolves.toEqual({ ok: false, error: FAILED });
    expect(client.fetchSession).not.toHaveBeenCalled();
    expect(gate.set).toHaveBeenCalledWith({ kind: "signed-in", session: SESSION, signOutError: FAILED });

    const after = render(gate.set.mock.calls.at(-1)![0]);
    expect(after.html).toContain(FAILED);
    expect(after.html).toMatch(/role="alert"/);
    expect(after.html).toContain("the app");
  });

  it("reads the session again after signing out, and hands the caller the result", async () => {
    client.signOut.mockResolvedValue({ ok: true });
    client.fetchSession.mockResolvedValue(null);
    const { session } = render({ kind: "signed-in", session: SESSION, signOutError: FAILED });
    await expect(session.signOut()).resolves.toEqual({ ok: true });
    expect(client.fetchSession).toHaveBeenCalledTimes(1);
    expect(gate.set).toHaveBeenLastCalledWith({ kind: "signed-out", error: null, busy: false });
  });
});
