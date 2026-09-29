import { afterEach, describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import { UserFacingError } from "@/lib/contract-error";
import { shortAddress } from "@/lib/format";
import type { Approval } from "@/lib/approvals";
import {
  allowanceText,
  ALLOWANCE_STILL_SET,
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
  it("is the exact sentence shown when a confirmed revoke's re-read allowance isn't zero", () => {
    expect(ALLOWANCE_STILL_SET).toBe("The revoke went through, but an allowance is still set.");
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
