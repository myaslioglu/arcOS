import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import { UserFacingError } from "@/lib/contract-error";
import { shortAddress } from "@/lib/format";
import type { Approval } from "@/lib/approvals";
import {
  allowanceText,
  APPROVE_ABI,
  fetchApprovals,
  focusTargetAfterRemoval,
  forgetRevokes,
  inspectButtonLabel,
  markRevoked,
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
