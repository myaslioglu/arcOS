import { afterEach, describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import { UserFacingError } from "@/lib/contract-error";
import type { Approval } from "@/lib/approvals";
import {
  allowanceText,
  fetchApprovals,
  forgetRevokes,
  markRevoked,
  parseApprovalsAnswer,
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
