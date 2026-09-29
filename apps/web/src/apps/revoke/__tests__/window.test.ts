import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Approval, ApprovalsAnswer } from "@/lib/approvals";

// The window reads the account from wagmi and the list from React Query; these tests only need their answers.
// Nothing here reaches the network, and nothing is signed.
const state = vi.hoisted(() => ({
  address: undefined as string | undefined,
  query: {
    isPending: false,
    isError: false,
    data: undefined as ApprovalsAnswer | undefined,
    refetch: async () => undefined,
  },
}));
vi.mock("wagmi", () => ({
  useAccount: () => ({ address: state.address, chainId: 5042002 }),
  usePublicClient: () => undefined,
  useWriteContract: () => ({ writeContractAsync: async () => "0x" }),
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => state.query }));
vi.mock("@arcos/shell", () => ({ useDesktop: () => ({ open: () => true }) }));
vi.mock("@/components/ConnectGate", () => ({ ConnectGate: ({ children }: { children: unknown }) => children }));

import { shortAddress } from "@/lib/format";
import { forgetRevokes, markRevoked } from "../rows";
import RevokeWindow from "../Window";

const OWNER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x3333333333333333333333333333333333333333";
const UNKNOWN = "0x5555555555555555555555555555555555555555";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const NOTE = "Token approvals only. NFT and Permit2 approvals come later.";

const row = (over: Partial<Approval> = {}): Approval => ({
  token: TOKEN,
  symbol: "AAA",
  name: "Token A",
  decimals: 18,
  spender: PERMIT2,
  spenderLabel: "Permit2",
  allowance: (2n ** 256n - 1n).toString(),
  lastApprovalBlock: 10,
  ...over,
});
/** React escapes an apostrophe in static markup; read it back as typed. */
const render = (params: Record<string, string> = {}) =>
  renderToStaticMarkup(createElement(RevokeWindow, { winId: "w-1", params })).replaceAll("&#x27;", "'");
const listing = (approvals: Approval[], truncated = false) => {
  state.query = { ...state.query, data: { approvals, truncated } };
};

beforeEach(() => {
  state.address = undefined;
  state.query = { isPending: false, isError: false, data: { approvals: [], truncated: false }, refetch: async () => undefined };
  forgetRevokes();
});

describe("Revoke", () => {
  it("asks for a wallet or an address when it has neither", () => {
    const html = render();
    expect(html).toContain("Connect a wallet, or paste an address to look.");
    expect(html).toContain(NOTE);
  });

  it("says when the address it was opened for isn't one", () => {
    expect(render({ owner: "0x12" })).toContain("That isn't an address.");
  });

  it("shows a pasted address's approvals read-only, with no Revoke buttons", () => {
    state.address = OWNER;
    listing([row()]);
    const html = render({ owner: OTHER });
    expect(html).toContain("AAA");
    expect(html).toContain("Token A");
    expect(html).toContain("Unlimited");
    expect(html).toContain("Permit2");
    expect(html).toContain("Only its own wallet can revoke.");
    expect(html).not.toContain(">Revoke</button>");
  });

  it("lets the connected wallet revoke its own approvals", () => {
    state.address = OWNER;
    listing([row()]);
    expect(render()).toContain(">Revoke</button>");
  });

  it("names an unknown spender by its short address, and offers to inspect it", () => {
    state.address = OWNER;
    listing([row({ spender: UNKNOWN, spenderLabel: null })]);
    const html = render();
    expect(html).toContain("Unknown contract");
    expect(html).toContain("0x5555…5555");
    expect(html).toContain(">Inspect</button>");
  });

  it("says when there are no active approvals", () => {
    state.address = OWNER;
    expect(render()).toContain("No active token approvals.");
  });

  it("says when the list is still loading, or couldn't load", () => {
    state.address = OWNER;
    state.query = { ...state.query, isPending: true, data: undefined };
    expect(render()).toContain("Loading approvals…");
    state.query = { ...state.query, isPending: false, isError: true };
    expect(render()).toContain("Couldn't load approvals. Try again in a minute.");
  });

  it("says when the list was cut short", () => {
    state.address = OWNER;
    listing([row()], true);
    expect(render()).toContain("This list may be incomplete: some approvals couldn't be read.");
  });

  it("never says there are no approvals when the list may be incomplete", () => {
    state.address = OWNER;
    listing([], true);
    const html = render();
    expect(html).toContain("This list may be incomplete: some approvals couldn't be read.");
    expect(html).not.toContain("No active token approvals.");
  });

  it("shows each token's address next to its symbol, so a look-alike can be told apart", () => {
    state.address = OWNER;
    listing([row()]);
    expect(render()).toContain(`${row().symbol} · ${shortAddress(row().token)}`);
  });

  it("keeps the note under every state", () => {
    state.address = OWNER;
    listing([row()]);
    expect(render()).toContain(NOTE);
    expect(render({ owner: "0x12" })).toContain(NOTE);
  });

  it("keeps a new owner's list free of a pair the previous owner revoked (owner-scoped via markRevoked/stillLive)", () => {
    const pair = row({ lastApprovalBlock: 10 });
    markRevoked(OWNER, pair, 50);
    state.address = OWNER;
    listing([pair]);
    expect(render({ owner: OWNER })).not.toContain("AAA");
    state.address = OTHER;
    listing([pair]);
    expect(render({ owner: OTHER })).toContain("AAA");
  });

  it("marks the window-level invalid-address message as an alert", () => {
    // LookupForm's own inline "bad" message (also role="alert" now, by the same edit) needs a submit event to
    // reach — not reproducible via renderToStaticMarkup, same limitation noted on the remount scan above — so only
    // the view-level message (reachable via the owner param, as the Terminal or a bad link would set it) is checked
    // here.
    expect(render({ owner: "0x12" })).toMatch(/<p[^>]*role="alert"[^>]*>That isn't an address\.<\/p>/);
  });

  it("marks the loading message as a live region, and the couldn't-load and truncated messages as alerts", () => {
    state.address = OWNER;
    state.query = { ...state.query, isPending: true, data: undefined };
    expect(render()).toMatch(/<p[^>]*aria-live="polite"[^>]*>Loading approvals…<\/p>/);
    state.query = { ...state.query, isPending: false, isError: true };
    expect(render()).toMatch(/<p[^>]*role="alert"[^>]*>Couldn't load approvals\. Try again in a minute\.<\/p>/);
    state.query = { ...state.query, isError: false, data: { approvals: [row()], truncated: true } };
    expect(render()).toMatch(/<p[^>]*role="alert"[^>]*>This list may be incomplete: some approvals couldn't be read\.<\/p>/);
  });

  it("labels the Revoke and Inspect buttons with the token and the spender", () => {
    state.address = OWNER;
    listing([row()]);
    expect(render()).toContain('aria-label="Revoke AAA for Permit2"');
    listing([row({ spender: UNKNOWN, spenderLabel: null })]);
    expect(render()).toContain(`aria-label="Inspect spender ${shortAddress(UNKNOWN)}"`);
  });

  it("titles the token and spender lines with their full addresses, for a look-alike symbol or label", () => {
    state.address = OWNER;
    listing([row()]);
    const html = render();
    expect(html).toContain(`title="${TOKEN}"`);
    expect(html).toContain(`title="${PERMIT2}"`);
  });

  it("lets the symbol and allowance lines wrap, so a hostile value can't push the Revoke button off screen", () => {
    state.address = OWNER;
    listing([row()]);
    const html = render();
    expect(html).toMatch(/class="break-all font-mono text-sm"/);
    expect(html).toMatch(/class="min-w-0 break-all font-mono text-sm"/);
  });
});

/**
 * A source scan, not a render test: renderToStaticMarkup gives every call a fresh component instance (no fiber
 * tree persists between calls), so the bug this guards against — React reusing ApprovalList's mounted `busy` /
 * `failures` / `left` state across a live wallet switch (same window, same component position, only the `owner`
 * prop changes) — can't be reproduced by rendering twice with different params; both calls already start clean
 * regardless of whether the fix is applied. This mirrors why apps/web/src/lib/__tests__/paid-write.test.ts scans
 * source text instead of rendering: there is no jsdom harness here to mount a component, change its props, and
 * watch what state survives.
 */
describe("ApprovalList remounts per owner (a wallet switch must not carry the previous owner's state)", () => {
  const source = readFileSync(path.resolve(import.meta.dirname, "..", "Window.tsx"), "utf8");

  it("keys both <ApprovalList> renders by the owner being shown, so a new owner mounts a fresh instance", () => {
    const tags = source.match(/<ApprovalList\b[^>]*>/g) ?? [];
    expect(tags.length).toBeGreaterThanOrEqual(2);
    for (const tag of tags) expect(tag).toMatch(/key=\{view\.owner\}/);
  });

  it("has no owner-unaware local state left that could hide a live row across a wallet switch", () => {
    // `gone` was keyed by rowKey (token:spender) alone, with no owner in it — the exact shape that, without the key
    // fix above, could let one owner's revoke hide a different owner's still-live approval of the same pair (Permit2
    // is one fixed address every wallet can approve). Hiding a revoked pair is markRevoked/stillLive's job now, and
    // those already carry the owner in their own key (rows.ts's revokedAt map).
    expect(source).not.toMatch(/\bgone\b/);
  });
});
