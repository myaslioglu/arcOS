import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import { UserFacingError } from "@/lib/contract-error";
import { shortAddress } from "@/lib/format";
import type { DragItem } from "@arcos/shell";
import type { Approval } from "@/lib/approvals";
import {
  allowanceText,
  approvalText,
  APPROVE_ABI,
  dragItemOf,
  rowForDrop,
  fetchApprovals,
  focusTargetAfterRemoval,
  focusWasLost,
  forgetRevokes,
  inspectButtonLabel,
  markRevoked,
  nodeHasSeenApproval,
  parseApprovalsAnswer,
  revokeButtonLabel,
  revokeFailure,
  revokeView,
  rowKey,
  stillLive,
} from "../rows";

const OWNER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const MIXED = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const TOKEN = "0x3333333333333333333333333333333333333333";
const SPENDER = "0x5555555555555555555555555555555555555555";
const row = (over: Partial<Approval> = {}): Approval => ({
  kind: "erc20",
  token: TOKEN,
  symbol: "AAA",
  name: "Token A",
  decimals: 18,
  spender: SPENDER,
  spenderLabel: null,
  allowance: "1500000000000000000",
  lastApprovalBlock: 10,
  ...over,
});

afterEach(() => {
  forgetRevokes();
});

describe("revokeView", () => {
  it("shows the address it was opened for, revocable only when it is the connected wallet's", () => {
    expect(revokeView(OTHER, OWNER)).toEqual({ kind: "list", owner: OTHER, canRevoke: false });
    expect(revokeView(MIXED.toUpperCase().replace("0X", "0x"), MIXED)).toEqual({
      kind: "list",
      owner: getAddress(MIXED),
      canRevoke: true,
    });
    expect(revokeView(OTHER, undefined)).toEqual({ kind: "list", owner: OTHER, canRevoke: false });
    expect(revokeView("0x12", OWNER)).toEqual({ kind: "invalid" });
  });

  it("falls back to the connected wallet, then asks for one", () => {
    expect(revokeView(undefined, OWNER)).toEqual({ kind: "list", owner: OWNER, canRevoke: true });
    expect(revokeView("", OWNER)).toEqual({ kind: "list", owner: OWNER, canRevoke: true });
    expect(revokeView(undefined, undefined)).toEqual({ kind: "ask" });
  });
});

describe("allowanceText", () => {
  it("reads 2^255 or more as Unlimited, and the rest at the token's decimals", () => {
    expect(allowanceText((2n ** 255n).toString(), 18)).toBe("Unlimited");
    expect(allowanceText((2n ** 256n - 1n).toString(), 6)).toBe("Unlimited");
    expect(allowanceText((2n ** 255n - 1n).toString(), null)).toBe(`${2n ** 255n - 1n} units`);
    expect(allowanceText("1500000000000000000", 18)).toBe("1.5");
    expect(allowanceText("12345", null)).toBe("12345 units");
  });
});

describe("parseApprovalsAnswer", () => {
  it("reads the route's answer, checksumming addresses and cleaning labels again", () => {
    const answer = parseApprovalsAnswer({
      approvals: [{ ...row(), token: TOKEN.toLowerCase(), symbol: "A\u202EAA" }],
      truncated: true,
    });
    expect(answer).toEqual({ approvals: [row()], truncated: true });
  });

  it("refuses anything else", () => {
    const good = row();
    const bad: unknown[] = [
      null,
      {},
      { approvals: [], truncated: "no" },
      { approvals: [{ ...good, token: "nope" }], truncated: false },
      { approvals: [{ ...good, allowance: "1e18" }], truncated: false },
      { approvals: [{ ...good, lastApprovalBlock: "10" }], truncated: false },
    ];
    for (const value of bad) expect(() => parseApprovalsAnswer(value)).toThrow();
  });
});

describe("fetchApprovals", () => {
  it("asks the route for the owner, and fails on an error status", async () => {
    const ok = vi.fn(async () => Response.json({ approvals: [], truncated: false }));
    expect(await fetchApprovals(OWNER, ok as unknown as typeof fetch)).toEqual({ approvals: [], truncated: false });
    expect(ok).toHaveBeenCalledWith(`/api/approvals?owner=${OWNER}`);
    const down = async () => Response.json({ error: "Couldn't load approvals. Try again in a minute." }, { status: 503 });
    await expect(fetchApprovals(OWNER, down as unknown as typeof fetch)).rejects.toThrow();
  });
});

describe("stillLive", () => {
  it("hides a pair revoked in this page until a newer approval appears, for that owner only", () => {
    markRevoked(OWNER, row(), 50);
    expect(stillLive(OWNER, [row({ lastApprovalBlock: 10 })])).toEqual([]);
    expect(stillLive(OWNER, [row({ lastApprovalBlock: 51 })])).toHaveLength(1);
    expect(stillLive(OTHER, [row({ lastApprovalBlock: 10 })])).toHaveLength(1);
    expect(rowKey({ token: TOKEN, spender: SPENDER })).toBe(rowKey({ token: TOKEN.toLowerCase() as `0x${string}`, spender: SPENDER }));
  });

  // The zero shortcut in Window.tsx marks a pair revoked at its own lastApprovalBlock, so equality is the edge that
  // matters: an approval at the very block of the revoke is the one just revoked, and stays hidden.
  it("hides a pair whose newest approval is at the very block it was marked revoked at, and shows a later one", () => {
    expect(row().lastApprovalBlock).toBe(10);
    markRevoked(OWNER, row(), 10);
    expect(stillLive(OWNER, [row()])).toEqual([]);
    expect(stillLive(OWNER, [row({ lastApprovalBlock: 9 })])).toEqual([]);
    expect(stillLive(OWNER, [row({ lastApprovalBlock: 11 })])).toHaveLength(1);
  });
});

describe("nodeHasSeenApproval", () => {
  // The explorer names the block of a pair's newest Approval. A node whose head is behind that block hasn't seen the
  // approval yet, so it can answer 0 for an allowance that is live; only a node at or past the block can be believed.
  it("believes a node at the approval's block or past it, and not one still behind it", () => {
    expect(nodeHasSeenApproval(11n, 10)).toBe(true);
    expect(nodeHasSeenApproval(10n, 10)).toBe(true);
    expect(nodeHasSeenApproval(9n, 10)).toBe(false);
    expect(nodeHasSeenApproval(0n, 10)).toBe(false);
  });

  it("reads the block numbers as the integers they are, however large", () => {
    expect(nodeHasSeenApproval(0n, 0)).toBe(true);
    expect(nodeHasSeenApproval(BigInt(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(nodeHasSeenApproval(BigInt(Number.MAX_SAFE_INTEGER) - 1n, Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(nodeHasSeenApproval(2n ** 64n, Number.MAX_SAFE_INTEGER)).toBe(true);
  });
});

/** A minimal, synchronous Storage stand-in: enough of the interface markRevoked/stillLive use. */
function fakeSessionStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

/** Every access throws, the way a private window or storage the visitor blocked behaves. */
function throwingSessionStorage(): Storage {
  const boom = () => {
    throw new Error("storage blocked");
  };
  return {
    getItem: boom,
    setItem: boom,
    removeItem: boom,
    clear: boom,
    key: boom,
    get length(): number {
      return boom();
    },
  } as Storage;
}

describe("markRevoked / stillLive persist to sessionStorage, under one key scoped by owner", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("writes through to sessionStorage under a key scoped by the lowercased owner", () => {
    const storage = fakeSessionStorage();
    vi.stubGlobal("sessionStorage", storage);

    markRevoked(getAddress(OWNER), row(), 50);

    expect(storage.getItem(`arcos-revoked:${OWNER.toLowerCase()}`)).not.toBeNull();
    expect(storage.getItem(`arcos-revoked:${OTHER.toLowerCase()}`)).toBeNull();
  });

  it("survives a fresh module instance (a reload in the same tab) through sessionStorage, since the in-memory map alone would have reset", async () => {
    const storage = fakeSessionStorage();
    vi.stubGlobal("sessionStorage", storage);
    markRevoked(OWNER, row(), 50);

    vi.resetModules();
    const fresh = await import("../rows");
    try {
      expect(fresh.stillLive(OWNER, [row({ lastApprovalBlock: 10 })])).toEqual([]);
      expect(fresh.stillLive(OWNER, [row({ lastApprovalBlock: 51 })])).toHaveLength(1);
    } finally {
      fresh.forgetRevokes();
    }
  });

  it("falls back to memory within this page load when sessionStorage throws on every access", () => {
    vi.stubGlobal("sessionStorage", throwingSessionStorage());

    markRevoked(OWNER, row(), 50);

    expect(stillLive(OWNER, [row({ lastApprovalBlock: 10 })])).toEqual([]);
    expect(stillLive(OWNER, [row({ lastApprovalBlock: 51 })])).toHaveLength(1);
  });
});

describe("stored revokes are checked when read back", () => {
  // What sits in sessionStorage is not trusted: another version of the page, a script or a hand edit can leave any
  // shape under the key. A bad shape reads as no revokes; it must never break the list or hide a pair for good.
  const KEY = `arcos-revoked:${OWNER.toLowerCase()}`;
  const pair = (n: number): Approval => row({ spender: `0x${n.toString(16).padStart(40, "0")}` });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads a stored JSON null as no revokes, and stillLive does not throw", () => {
    const storage = fakeSessionStorage();
    vi.stubGlobal("sessionStorage", storage);
    storage.setItem(KEY, "null");

    expect(() => stillLive(OWNER, [row()])).not.toThrow();
    expect(stillLive(OWNER, [row()])).toEqual([row()]);
  });

  it("ignores a stored array, and the next revoke is still saved as an object", () => {
    const storage = fakeSessionStorage();
    vi.stubGlobal("sessionStorage", storage);
    storage.setItem(KEY, "[50]");

    expect(stillLive(OWNER, [row({ lastApprovalBlock: 10 })])).toHaveLength(1);
    markRevoked(OWNER, row(), 60);
    expect(JSON.parse(storage.getItem(KEY) as string)).toEqual({ [rowKey(row())]: 60 });
  });

  it("drops an entry that is not a non-negative safe integer, and keeps a valid one beside it", () => {
    const storage = fakeSessionStorage();
    vi.stubGlobal("sessionStorage", storage);
    const valid = pair(1);
    const junk = ["x", -1, 1.5, "50", 2 ** 53].map((value, i) => ({ value, approval: pair(i + 2) }));
    const stored: Record<string, unknown> = { [rowKey(valid)]: 50 };
    for (const { value, approval } of junk) stored[rowKey(approval)] = value;
    storage.setItem(KEY, JSON.stringify(stored));

    // A dropped entry hides nothing. "x" used to hide its pair whatever the block, since a comparison with NaN is false.
    for (const { value, approval } of junk) {
      expect(stillLive(OWNER, [approval]), `stored ${JSON.stringify(value)}`).toHaveLength(1);
    }
    // The valid entry still hides its pair up to its block.
    expect(stillLive(OWNER, [valid])).toEqual([]);
    expect(stillLive(OWNER, [{ ...valid, lastApprovalBlock: 51 }])).toHaveLength(1);

    // The next write keeps the valid entry and adds the new one, and nothing else.
    markRevoked(OWNER, row(), 60);
    expect(JSON.parse(storage.getItem(KEY) as string)).toEqual({ [rowKey(valid)]: 50, [rowKey(row())]: 60 });
  });
});

describe("revokeFailure", () => {
  it("says how far a failed revoke got, and never reads a sent one as nothing happened", () => {
    expect(revokeFailure("signing", { code: 4001 })).toBe("You cancelled the request in your wallet.");
    expect(
      revokeFailure("signing", new UserFacingError("Your wallet is on a different network. Switch to Arc and try again.")),
    ).toBe("Your wallet is on a different network. Switch to Arc and try again.");
    expect(revokeFailure("sent", new Error("timeout"))).toBe(
      "The revoke was sent but isn't confirmed yet. Check the explorer before trying again.",
    );
    expect(revokeFailure("sent", new UserFacingError("The revoke reverted. The approval is unchanged."))).toBe(
      "The revoke reverted. The approval is unchanged.",
    );
    expect(revokeFailure("confirmed", new Error("rpc down"))).toBe(
      "The revoke went through, but the allowance couldn't be read again. Reopen Revoke to check it.",
    );
  });
});

describe("APPROVE_ABI", () => {
  it("declares approve with no outputs, so a token whose approve returns nothing still decodes", () => {
    const approve = APPROVE_ABI.find((item) => item.type === "function" && item.name === "approve");
    expect(approve).toBeDefined();
    expect(approve?.outputs).toEqual([]);
  });
});

describe("ALLOWANCE_STILL_SET", () => {
  // A source scan, not a behavioural render test: the branch that shows this sentence only runs
  // inside `revoke()`'s async handler, after a confirmed transaction and a live re-read — not
  // reachable through renderToStaticMarkup (see window.test.ts's own scans for the same limitation).
  // This checks the constant is actually wired into that branch's shown text, rather than asserting
  // the constant equals its own literal.
  const source = readFileSync(path.resolve(import.meta.dirname, "..", "Window.tsx"), "utf8");

  it("is the failure text Window.tsx shows when a confirmed revoke's re-read allowance isn't zero", () => {
    expect(source).toMatch(/text:\s*ALLOWANCE_STILL_SET/);
  });
});

describe("focusTargetAfterRemoval", () => {
  it("targets the row that now sits where the removed one was", () => {
    expect(focusTargetAfterRemoval(["a", "b", "c"], "b")).toEqual({ kind: "row", key: "c" });
  });

  it("targets the new last row when the removed one was last", () => {
    expect(focusTargetAfterRemoval(["a", "b", "c"], "c")).toEqual({ kind: "row", key: "b" });
  });

  it("targets the heading when no row is left", () => {
    expect(focusTargetAfterRemoval(["a"], "a")).toEqual({ kind: "heading" });
  });

  it("targets the heading when the removed key isn't in the list (already gone, or never was)", () => {
    expect(focusTargetAfterRemoval(["a", "b"], "z")).toEqual({ kind: "heading" });
  });

  it("targets the next row when the first was removed, which shifts up into its place", () => {
    expect(focusTargetAfterRemoval(["a", "b", "c"], "a")).toEqual({ kind: "row", key: "b" });
  });

  // Window.tsx keeps the target while the revoke finishes and focuses it after the list has re-rendered without the
  // removed row, so a target that named the removed row itself would point at nothing.
  it("never names the removed row, wherever it stood", () => {
    const keys = ["a", "b", "c", "d"];
    for (const removed of keys) {
      const target = focusTargetAfterRemoval(keys, removed);
      expect(target.kind).toBe("row");
      if (target.kind === "row") {
        expect(target.key).not.toBe(removed);
        expect(keys).toContain(target.key);
      }
    }
  });
});

describe("focusWasLost", () => {
  // Small stand-ins for DOM nodes: all that is read is which object holds focus, and whether it is the body.
  const body = { tagName: "BODY" };
  const button = { tagName: "BUTTON" };
  const input = { tagName: "INPUT" };

  // Focus lands on the body when the element that held it goes away (a revoked row) or is disabled (a Revoke button while
  // a revoke runs), and nothing holds it at all before the page has been clicked.
  it("is true when nothing holds focus, or the body does", () => {
    expect(focusWasLost(null, body)).toBe(true);
    expect(focusWasLost(body, body)).toBe(true);
  });

  // A visitor who has moved on, to the lookup field, an Inspect button or a window of another app, keeps their place: their
  // next Space or Enter must not start a revoke they didn't choose.
  it("is false for any other element", () => {
    expect(focusWasLost(button, body)).toBe(false);
    expect(focusWasLost(input, body)).toBe(false);
    expect(focusWasLost(button, null)).toBe(false);
  });
});

describe("revokeButtonLabel", () => {
  it("names the token by symbol and the spender by its resolved label", () => {
    expect(revokeButtonLabel({ token: TOKEN, symbol: "USDC", spender: SPENDER }, "Permit2")).toBe("Revoke USDC for Permit2");
  });

  it("falls back to short addresses when the token has no symbol or the spender has no label", () => {
    expect(revokeButtonLabel({ token: TOKEN, symbol: null, spender: SPENDER }, null)).toBe(
      `Revoke ${shortAddress(TOKEN)} for spender ${shortAddress(SPENDER)}`,
    );
  });
});

describe("inspectButtonLabel", () => {
  it("names the spender by its short address", () => {
    expect(inspectButtonLabel(SPENDER)).toBe(`Inspect spender ${shortAddress(SPENDER)}`);
  });
});

/**
 * A source scan, not a behavioural render test (see the ALLOWANCE_STILL_SET scan above for why:
 * revoke()'s async handler isn't reachable through renderToStaticMarkup, and the window.test.ts mocks
 * usePublicClient to return undefined, so revoke() always returns at its first guard there too).
 *
 * Review Important 1: a revoke could reappear after a reload within the server's 60 s cache, and
 * clicking Revoke on an already-revoked pair would simulate and send a no-op approve(spender, 0),
 * prompting the wallet and costing gas for nothing. The fix reads the allowance live, the same read
 * used after the receipt, before ever asking the wallet to sign — and returns without simulating or
 * writing when it's already zero.
 */
describe("Window.tsx reads the allowance live before ever asking the wallet (Important 1)", () => {
  const source = readFileSync(path.resolve(import.meta.dirname, "..", "Window.tsx"), "utf8");
  // liveAllowance: a marker unique to the new pre-check (unlike "already", which also appears in an
  // unrelated, earlier comment about stillLive already carrying the owner in its own key). The paid-write
  // scan (lib/__tests__/paid-write.test.ts) already pins simulateContract → writeContractAsync(withChain(
  // …)); this only needs to place the new live read between assertWalletOnChain and simulateContract, so
  // it doesn't repeat that literal call-site text here too (the scan's own file-selection net would
  // otherwise sweep this test file up as a fourth "paid write" site to check).
  const liveCheck = source.indexOf("liveAllowance");
  const simulate = source.indexOf("simulateContract(");

  it("checks the live allowance after assertWalletOnChain and before simulateContract", () => {
    const assertCall = source.indexOf("assertWalletOnChain(");
    expect(assertCall).toBeGreaterThan(-1);
    expect(liveCheck).toBeGreaterThan(assertCall);
    expect(simulate).toBeGreaterThan(liveCheck);
  });

  it("returns, without reaching simulateContract, when the live read is already zero — so an already-revoked pair never prompts the wallet", () => {
    const zeroBranch = source.slice(liveCheck, simulate);
    expect(zeroBranch).toMatch(/===\s*0n/);
    expect(zeroBranch).toMatch(/\breturn\b/);
    expect(zeroBranch).toContain("markRevoked(");
  });
});

/**
 * Source scans again, for the same reason (revoke()'s async handler isn't reachable through renderToStaticMarkup, and
 * there is no DOM to mount the list in). What they pin is the order things happen in, which is where these two bugs were.
 */
describe("Window.tsx focuses the next row only once no revoke is running", () => {
  const source = readFileSync(path.resolve(import.meta.dirname, "..", "Window.tsx"), "utf8");
  const revokeBody = source.slice(source.indexOf("const revoke = async"), source.indexOf("return (\n    <div ref={listRef}"));

  // revoke() sets busy first and clears it in its `finally`, and every Revoke button is disabled={busy !== null} in
  // between, so a .focus() from inside revoke() lands on a disabled button and does nothing.
  it("only stores the target from inside revoke(), where every Revoke button is still disabled", () => {
    expect(revokeBody).toContain("focusTargetAfterRemoval(");
    expect(revokeBody).not.toMatch(/\.focus\(/);
  });

  // A revoke that throws before its first await (assertWalletOnChain can) sets busy and clears it in one batch, so busy
  // never changes and Window.tsx's effect never runs to forget the target that revoke stored. Left there, it would steer
  // the next revoke's focus, so every revoke forgets the last one's target itself, before it sets busy.
  it("forgets a target an earlier revoke left, before it sets busy", () => {
    // Whole statements on a line of their own, so a comment that names them can't be mistaken for them.
    const forgets = revokeBody.search(/^\s*pendingFocus\.current = null;$/m);
    const setsBusy = revokeBody.search(/^\s*setBusy\(key\);$/m);
    expect(forgets, "revoke() forgets the target").toBeGreaterThan(-1);
    expect(setsBusy, "revoke() sets busy").toBeGreaterThan(-1);
    expect(setsBusy).toBeGreaterThan(forgets);
  });

  it("focuses the stored target in an effect that waits for busy to be null, forgets it, and moves focus only if it was lost", () => {
    const effect = source.match(/useEffect\(\(\) => \{([\s\S]*?)\}, \[busy\]\);/)?.[1] ?? "";
    expect(effect, "an effect keyed on busy").not.toBe("");
    const at = (text: string) => effect.indexOf(text);
    // In this order: wait for busy, forget the target (one that is declined too), check that focus was lost, then focus.
    expect(at("busy !== null")).toBeGreaterThan(-1);
    expect(at("pendingFocus.current = null")).toBeGreaterThan(at("busy !== null"));
    expect(at("focusWasLost(document.activeElement, document.body)")).toBeGreaterThan(at("pendingFocus.current = null"));
    // The guard's polarity: it returns unless focus was lost. Without the `!`, focus would move only for a visitor who
    // had moved on, which is the theft the guard is there to prevent.
    expect(effect).toMatch(/if \(!focusWasLost\(document\.activeElement, document\.body\)\) return;/);
    expect(at(".focus()")).toBeGreaterThan(at("focusWasLost("));
    // The list's own container stands in for the heading target, and for a row that is gone by then.
    expect(effect).toMatch(/\?\?\s*listRef\.current/);
  });

  // The Revoke button that was clicked is disabled while busy, so focus drops to the body. A revoke that ends without
  // removing its row (a failure) sends focus back to that row's button through the same effect, and so the same guard.
  it("sends focus back to the row's own button when a revoke ends without removing it", () => {
    const ending = revokeBody.match(/finally \{([\s\S]*?)\n    \}/)?.[1] ?? "";
    expect(ending, "revoke()'s finally").not.toBe("");
    expect(ending).toMatch(/pendingFocus\.current === null\)\s*pendingFocus\.current = \{ kind: "row", key \}/);
    expect(ending.indexOf("setBusy(null)")).toBeGreaterThan(ending.indexOf("pendingFocus.current"));
  });
});

describe("Window.tsx doesn't believe a zero from a node that is behind the approval (lagging node)", () => {
  const source = readFileSync(path.resolve(import.meta.dirname, "..", "Window.tsx"), "utf8");
  const assertCall = source.indexOf("assertWalletOnChain(");
  const headRead = source.indexOf("getBlockNumber(");
  const liveCheck = source.indexOf("liveAllowance");
  const simulate = source.indexOf("simulateContract(");

  it("reads the head live first, after assertWalletOnChain and before the allowance and simulateContract", () => {
    expect(assertCall).toBeGreaterThan(-1);
    expect(headRead).toBeGreaterThan(assertCall);
    expect(liveCheck).toBeGreaterThan(headRead);
    expect(simulate).toBeGreaterThan(liveCheck);
    expect(source).toMatch(/getBlockNumber\(\{\s*cacheTime:\s*0\s*\}\)/);
  });

  it("reads the allowance at that head, and takes the already-zero shortcut only when the node has reached the approval", () => {
    const readAndShortcut = source.slice(liveCheck, simulate);
    expect(readAndShortcut).toMatch(/blockNumber:\s*head\b/);
    expect(readAndShortcut).toMatch(/===\s*0n\s*&&\s*nodeHasSeenApproval\(head,\s*row\.lastApprovalBlock\)/);
    expect(readAndShortcut).toContain("markRevoked(");
  });
});

describe("the other kinds of approval", () => {
  const nft = row({ kind: "erc721", symbol: "PUNK", decimals: null, allowance: "1", tokenId: "7" });
  const operator = row({ kind: "operator", symbol: "PUNK", decimals: null, allowance: "1" });
  const permit2 = row({ kind: "permit2", allowance: "5000000000000000000", expiration: 1_900_000_000 });

  it("parses each kind, with an NFT's id and a Permit2 expiry, and refuses a kind it doesn't know or a field that doesn't fit", () => {
    expect(parseApprovalsAnswer({ approvals: [nft, operator, permit2], truncated: false }).approvals).toEqual([nft, operator, permit2]);
    const bad: unknown[] = [
      { ...row(), kind: "erc1155" },
      { ...row(), kind: undefined },
      { ...nft, tokenId: undefined },
      { ...nft, tokenId: "0x7" },
      { ...nft, tokenId: "-7" },
      { ...permit2, expiration: "soon" },
      { ...permit2, expiration: -1 },
    ];
    for (const value of bad) expect(() => parseApprovalsAnswer({ approvals: [value], truncated: false }), JSON.stringify(value)).toThrow();
  });

  it("drops an id or an expiry on a kind that has none", () => {
    const [parsed] = parseApprovalsAnswer({ approvals: [{ ...row(), tokenId: "7", expiration: 9 }], truncated: false }).approvals;
    expect(parsed).toEqual(row());
  });

  it("keys an ERC-20 pair as before, and each other kind apart from it, an NFT by its id", () => {
    expect(rowKey(row())).toBe(`${TOKEN}:${SPENDER}`.toLowerCase());
    expect(new Set([row(), nft, operator, permit2].map(rowKey)).size).toBe(4);
    expect(rowKey(nft)).toBe(`erc721:${TOKEN.toLowerCase()}:7`);
    expect(rowKey({ ...nft, spender: OTHER })).toBe(rowKey(nft));
  });

  it("says what each kind allows", () => {
    expect(approvalText(row())).toBe("1.5");
    expect(approvalText(nft)).toBe("NFT #7");
    expect(approvalText(operator)).toBe("Every item");
    expect(approvalText({ ...permit2, allowance: (2n ** 160n - 1n).toString(), decimals: 18 })).toBe("Unlimited");
    expect(approvalText(permit2)).toBe("5");
  });

  it("reads Permit2's maximum, 2^160 - 1, as Unlimited", () => {
    expect(allowanceText((2n ** 160n - 1n).toString(), 18, "permit2")).toBe("Unlimited");
    expect(allowanceText((2n ** 160n - 1n).toString(), 18)).not.toBe("Unlimited");
  });

  it("names the NFT in the Revoke button", () => {
    expect(revokeButtonLabel(nft, "Permit2")).toBe("Revoke PUNK #7 for Permit2");
  });

  it("drags a row as an approval item, and finds the row a dropped item names, never one it doesn't", () => {
    expect(dragItemOf(row())).toEqual({ kind: "approval", approval: "erc20", token: TOKEN, spender: SPENDER });
    expect(dragItemOf(nft)).toEqual({ kind: "approval", approval: "erc721", token: TOKEN, spender: SPENDER, tokenId: "7" });
    const rows = [row(), nft, operator, permit2];
    for (const r of rows) expect(rowForDrop(rows, dragItemOf(r))).toBe(r);
    expect(rowForDrop(rows, { ...(dragItemOf(row()) as Extract<DragItem, { kind: "approval" }>), token: OTHER })).toBeNull();
    expect(rowForDrop([row()], dragItemOf(permit2))).toBeNull();
    expect(rowForDrop(rows, { kind: "token", address: TOKEN, symbol: "AAA", decimals: 18 })).toBeNull();
  });
});
