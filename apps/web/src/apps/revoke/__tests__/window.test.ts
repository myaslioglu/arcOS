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
    // TanStack Query tells the two error shapes apart: isLoadingError (data stays undefined — the
    // query has never once succeeded) and isRefetchError (data stays the last successful answer — a
    // background refetch failed on top of it). See QueryObserverLoadingErrorResult /
    // QueryObserverRefetchErrorResult in @tanstack/query-core.
    isLoadingError: false,
    isRefetchError: false,
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
vi.mock("@arcos/shell", () => ({
  useDesktop: () => ({ open: () => true }),
  // A row is dragged as the item it names; the trash area is a drop target. Only their markup matters here.
  dragSourceProps: (item: { approval: string }) => ({ draggable: true, "data-drag": item.approval }),
  useDropTarget: (accepts: string[] | undefined) => ({ over: false, props: { "data-accepts": accepts?.join(",") ?? "" } }),
}));
vi.mock("@/components/ConnectGate", () => ({ ConnectGate: ({ children }: { children: unknown }) => children }));

import { shortAddress } from "@/lib/format";
import type { RowOutcome } from "../flow";
import { forgetRevokes, markRevoked, rowKey } from "../rows";
import { revokeSession } from "../session";
import RevokeWindow from "../Window";

const OWNER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x3333333333333333333333333333333333333333";
const UNKNOWN = "0x5555555555555555555555555555555555555555";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const NOTE = "Lists token allowances, NFT approvals and Permit2 allowances. Each revoke is a transaction your wallet confirms.";

const row = (over: Partial<Approval> = {}): Approval => ({
  kind: "erc20",
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
  state.query = {
    isPending: false,
    isError: false,
    isLoadingError: false,
    isRefetchError: false,
    data: { approvals: [], truncated: false },
    refetch: async () => undefined,
  };
  forgetRevokes();
  revokeSession.forget();
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
    expect(render()).toContain("No active approvals.");
  });

  it("says when the list is still loading, or couldn't load", () => {
    state.address = OWNER;
    state.query = { ...state.query, isPending: true, data: undefined };
    expect(render()).toContain("Loading approvals…");
    state.query = { ...state.query, isPending: false, isError: true, isLoadingError: true };
    expect(render()).toContain("Couldn't load approvals. Try again in a minute.");
  });

  it("keeps showing the list when a refetch fails but the last answer is still there, instead of hiding it behind the error state", () => {
    state.address = OWNER;
    listing([row()]);
    state.query = { ...state.query, isError: true, isRefetchError: true };
    const html = render();
    expect(html).toContain("AAA");
    expect(html).toContain(">Revoke</button>");
    expect(html).toContain("Couldn't refresh approvals. Showing the last list.");
    expect(html).not.toContain("Couldn't load approvals. Try again in a minute.");
  });

  it("shows the full error state, not the list, when a refetch fails and there was never any data", () => {
    state.address = OWNER;
    state.query = { ...state.query, isPending: false, isError: true, isLoadingError: true, data: undefined };
    const html = render();
    expect(html).toContain("Couldn't load approvals. Try again in a minute.");
    expect(html).not.toContain("Couldn't refresh approvals. Showing the last list.");
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
    expect(html).not.toContain("No active approvals.");
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
    state.query = { ...state.query, isPending: false, isError: true, isLoadingError: true };
    expect(render()).toMatch(/<p[^>]*role="alert"[^>]*>Couldn't load approvals\. Try again in a minute\.<\/p>/);
    state.query = { ...state.query, isError: false, isLoadingError: false, data: { approvals: [row()], truncated: true } };
    expect(render()).toMatch(/<p[^>]*role="alert"[^>]*>This list may be incomplete: some approvals couldn't be read\.<\/p>/);
  });

  it("marks the approvals list as a region, the focus landmark that already has its aria-label", () => {
    state.address = OWNER;
    listing([row()]);
    expect(render()).toMatch(/<div[^>]*role="region"[^>]*aria-label="Approvals list"/);
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

describe("Revoke's other kinds of approval", () => {
  const NFT = "0x4444444444444444444444444444444444444444";
  const ROUTER = "0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1";

  it("shows what each kind allows: an amount, one NFT, every item, a Permit2 allowance and its expiry", () => {
    state.address = OWNER;
    listing([
      row(),
      row({ kind: "erc721", token: NFT, symbol: "PUNK", name: "Punks", decimals: null, allowance: "1", tokenId: "7", spender: UNKNOWN, spenderLabel: null }),
      row({ kind: "operator", token: NFT, symbol: "PUNK", name: "Punks", decimals: null, allowance: "1", spender: UNKNOWN, spenderLabel: null }),
      row({ kind: "permit2", allowance: "2500000000000000000", expiration: 1_900_000_000, spender: ROUTER, spenderLabel: "Uniswap Universal Router" }),
    ]);
    const html = render();
    expect(html).toContain("Token · Token A");
    expect(html).toContain("NFT #7");
    expect(html).toContain("Every item");
    expect(html).toContain("All items · Punks");
    expect(html).toContain("Permit2 · Token A");
    expect(html).toContain(">2.5<");
    expect(html).toContain("Expires 2030-03-17");
    expect(html).toContain("Uniswap Universal Router");
    expect(html).toContain('aria-label="Revoke PUNK #7 for spender 0x5555…5555"');
  });

  it("offers Revoke all, a trash area that takes approvals, and draggable rows, only to the owner's own wallet", () => {
    state.address = OWNER;
    listing([row(), row({ spender: UNKNOWN, spenderLabel: null })]);
    const own = render();
    expect(own).toContain(">Revoke all (2)</button>");
    expect(own).toContain("Drop an approval here to revoke it.");
    expect(own).toContain('data-accepts="approval"');
    expect(own.match(/data-drag="erc20"/g)).toHaveLength(2);

    const other = render({ owner: OTHER });
    expect(other).not.toContain("Revoke all");
    expect(other).not.toContain("Drop an approval here to revoke it.");
    expect(other).not.toContain("data-drag=");
  });

  it("offers no Revoke all for a single row", () => {
    state.address = OWNER;
    listing([row()]);
    expect(render()).not.toContain("Revoke all");
  });
});

/**
 * The transaction state lives in the revoke session (session.ts), not in the window: these render a fresh window
 * while a run is under way, then after it ended, as a window closed and opened again does. renderToStaticMarkup
 * mounts a new instance on every call, so each render below is a remount.
 */
describe("a remounted window picks up the revoke where it is", () => {
  const second = () => row({ spender: UNKNOWN, spenderLabel: null });

  function start(steps: Approval[][]) {
    const pending: ((o: RowOutcome[]) => void)[] = [];
    const done = revokeSession.run(OWNER as `0x${string}`, steps, () => new Promise<RowOutcome[]>((settle) => pending.push(settle)));
    return { pending, done: done! };
  }

  it("shows the row waiting on the wallet, every Revoke control disabled, and a bulk run's progress", async () => {
    state.address = OWNER;
    listing([row(), second()]);
    const { pending, done } = start([[row()], [second()]]);
    const html = render();
    expect(html).toContain("Waiting for your wallet…");
    expect(html).toContain("Revoking 1 of 2…");
    expect(html).toContain("You can close this window; the revokes continue.");
    expect(html).toContain(">Stop after this one</button>");
    const revokeButtons = html.match(/<button[^>]*aria-label="Revoke [^"]*"[^>]*>/g) ?? [];
    expect(revokeButtons).toHaveLength(2);
    for (const button of revokeButtons) expect(button).toContain('disabled=""');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Revoke all \(2\)<\/button>/);
    pending[0]!([{ key: rowKey(row()), result: "revoked", block: 11 }]);
    await new Promise((r) => setTimeout(r, 0));
    markRevoked(OWNER as `0x${string}`, row(), 11); // what revokeStep does for a revoked row
    const later = render();
    expect(later).toContain("Revoking 2 of 2…");
    // The revoked row has left the list; the other remains.
    expect(later).not.toContain('aria-label="Revoke AAA for Permit2"');
    expect(later).toContain(`aria-label="Revoke AAA for spender ${shortAddress(UNKNOWN)}"`);
    pending[1]!([]);
    await done;
  });

  it("keeps Stop while a bulk run has steps to go, however short the list has become", async () => {
    state.address = OWNER;
    const { pending, done } = start([[row()], [second()]]);
    for (const shown of [[second()], []]) {
      listing(shown);
      const html = render();
      expect(html).toContain(">Stop after this one</button>");
      expect(html).not.toContain("Revoke all");
    }
    pending[0]!([{ key: rowKey(row()), result: "revoked", block: 11 }]);
    await new Promise((r) => setTimeout(r, 0));
    pending[1]!([]);
    await done;
  });

  it("says it is waiting for confirmation once the wallet has signed", async () => {
    state.address = OWNER;
    listing([row(), second()]);
    let sent: () => void = () => undefined;
    let settle: (o: RowOutcome[]) => void = () => undefined;
    const done = revokeSession.run(OWNER as `0x${string}`, [[row()]], (_rows, onSent) => {
      sent = onSent;
      return new Promise<RowOutcome[]>((s) => (settle = s));
    })!;
    expect(render()).toContain(">Waiting for your wallet…</button>");
    sent();
    const html = render();
    expect(html).toContain(">Waiting for confirmation…</button>");
    expect(html).not.toContain("Waiting for your wallet…");
    settle([]);
    await done;
  });

  it("offers no Stop for a single-transaction run", async () => {
    state.address = OWNER;
    listing([row(), second()]);
    const { pending, done } = start([[row()]]);
    expect(render()).not.toContain("Stop after this one");
    pending[0]!([]);
    await done;
  });

  it("shows a failed revoke's sentence and its transaction after the window is opened again", async () => {
    state.address = OWNER;
    listing([row()]);
    const { pending, done } = start([[row()]]);
    pending[0]!([{ key: rowKey(row()), result: "failed", text: "The revoke reverted. The approval is unchanged.", hash: `0x${"ab".repeat(32)}` }]);
    await done;
    const html = render();
    expect(html).toContain("The revoke reverted. The approval is unchanged.");
    expect(html).toContain("View on the explorer");
    expect(html).toContain(">Revoke</button>");
    expect(html).not.toContain("Waiting for your wallet…");
  });

  it("shows what a confirmed revoke left, and keeps one owner's failures off another's list", async () => {
    state.address = OWNER;
    listing([row()]);
    const { pending, done } = start([[row()]]);
    pending[0]!([{ key: rowKey(row()), result: "still-set", left: "40", hash: `0x${"cd".repeat(32)}` }]);
    await done;
    expect(render()).toContain("The revoke went through, but an allowance is still set.");
    expect(render()).toContain("0.00000000000000004");
    state.address = OTHER;
    expect(render()).not.toContain("an allowance is still set");
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
