import { getAddress, isAddress, parseAbi, type Address } from "viem";
import { cleanLabel } from "@arcos/inspector";
import { formatTokenAmount } from "@/lib/amount";
import { isUnlimited, type Approval, type ApprovalsAnswer } from "@/lib/approvals";
import { describeContractError, UserFacingError } from "@/lib/contract-error";
import { shortAddress } from "@/lib/format";

export type RevokeView = { kind: "ask" } | { kind: "invalid" } | { kind: "list"; owner: Address; canRevoke: boolean };

/**
 * What the window shows: the address it was opened for, read-only unless it is the connected wallet's; else the
 * connected wallet's approvals, which it can revoke; else a request for a wallet or an address.
 */
export function revokeView(ownerParam: string | undefined, account: string | undefined): RevokeView {
  if (ownerParam) {
    if (!isAddress(ownerParam, { strict: false })) return { kind: "invalid" };
    const owner = getAddress(ownerParam);
    return { kind: "list", owner, canRevoke: !!account && account.toLowerCase() === owner.toLowerCase() };
  }
  if (account && isAddress(account, { strict: false })) return { kind: "list", owner: getAddress(account), canRevoke: true };
  return { kind: "ask" };
}

/** "Unlimited" at 2^255 or more, else the amount at the token's decimals; a token that didn't say its decimals shows raw units. */
export function allowanceText(allowance: string, decimals: number | null): string {
  const value = BigInt(allowance);
  if (isUnlimited(value)) return "Unlimited";
  return decimals === null ? `${value.toString()} units` : formatTokenAmount(value, decimals);
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const notAnAnswer = () => new Error("Not an approvals answer.");

/** /api/approvals' answer, checked field by field, labels cleaned again; anything else throws. */
export function parseApprovalsAnswer(json: unknown): ApprovalsAnswer {
  const o = typeof json === "object" && json !== null ? (json as { approvals?: unknown; truncated?: unknown }) : {};
  if (!Array.isArray(o.approvals) || typeof o.truncated !== "boolean") throw notAnAnswer();
  const approvals = o.approvals.map((raw): Approval => {
    const a = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    if (typeof a.token !== "string" || !ADDRESS.test(a.token)) throw notAnAnswer();
    if (typeof a.spender !== "string" || !ADDRESS.test(a.spender)) throw notAnAnswer();
    if (typeof a.allowance !== "string" || !/^\d+$/.test(a.allowance)) throw notAnAnswer();
    if (typeof a.lastApprovalBlock !== "number" || !Number.isSafeInteger(a.lastApprovalBlock)) throw notAnAnswer();
    const decimals =
      typeof a.decimals === "number" && Number.isInteger(a.decimals) && a.decimals >= 0 && a.decimals <= 255 ? a.decimals : null;
    return {
      token: getAddress(a.token),
      symbol: typeof a.symbol === "string" ? cleanLabel(a.symbol, 32) : null,
      name: typeof a.name === "string" ? cleanLabel(a.name, 64) : null,
      decimals,
      spender: getAddress(a.spender),
      spenderLabel: typeof a.spenderLabel === "string" ? a.spenderLabel : null,
      allowance: a.allowance,
      lastApprovalBlock: a.lastApprovalBlock,
    };
  });
  return { approvals, truncated: o.truncated };
}

/** Asks the server for the owner's live approvals; throws on an error status or a body that isn't an answer. */
export async function fetchApprovals(owner: Address, fetchFn: typeof fetch = fetch): Promise<ApprovalsAnswer> {
  const res = await fetchFn(`/api/approvals?owner=${owner}`);
  if (!res.ok) throw new Error(`/api/approvals answered ${res.status}`);
  return parseApprovalsAnswer(await res.json());
}

/** A (token, spender) pair's key, whatever the case of its letters. */
export const rowKey = (row: Pick<Approval, "token" | "spender">): string => `${row.token}:${row.spender}`.toLowerCase();

// Pairs revoked in this page, with the block each revoke landed in. The server keeps an owner's list for 60 s, so a
// window reopened in that time could list a pair that is already revoked; `stillLive` hides it until a newer approval
// of the same pair appears.
const revokedAt = new Map<string, number>();

export function markRevoked(owner: Address, row: Pick<Approval, "token" | "spender">, block: number): void {
  revokedAt.set(`${owner.toLowerCase()}:${rowKey(row)}`, block);
}

export function stillLive(owner: Address, rows: readonly Approval[]): Approval[] {
  return rows.filter((row) => {
    const at = revokedAt.get(`${owner.toLowerCase()}:${rowKey(row)}`);
    return at === undefined || row.lastApprovalBlock > at;
  });
}

/** Forgets every revoke this page made (for tests). */
export function forgetRevokes(): void {
  revokedAt.clear();
}

/** How far a revoke got before it failed: not sent yet, sent without a receipt, or confirmed. */
export type RevokeStage = "signing" | "sent" | "confirmed";

/**
 * The sentence for a failed revoke, by how far it got. Before sending: the wallet's error in words
 * (`describeContractError`). Once sent: a revert says so, and anything else means the receipt didn't come back, which
 * must never read as "nothing happened". Once confirmed: only reading the allowance again failed.
 */
export function revokeFailure(stage: RevokeStage, err: unknown): string {
  if (stage === "signing") return describeContractError(err);
  if (err instanceof UserFacingError) return err.message;
  if (stage === "sent") return "The revoke was sent but isn't confirmed yet. Check the explorer before trying again.";
  return "The revoke went through, but the allowance couldn't be read again. Reopen Revoke to check it.";
}

/**
 * approve(spender, amount) with no return value. erc20Abi declares approve as returning bool, so simulateContract
 * decodes the call's return data against that and throws AbiDecodingZeroDataError for a token (USDT-style) whose
 * approve sends back no data at all. Used for both the simulate and the write; the allowance re-read after the
 * receipt keeps using erc20Abi, since a view function's real uint256 return isn't the thing non-compliant tokens
 * get wrong.
 */
export const APPROVE_ABI = parseAbi(["function approve(address spender, uint256 amount)"]);

/**
 * Shown on a row after a confirmed revoke whose re-read allowance came back nonzero: the write went through (a
 * revert would have thrown before this point), but something re-approved, or partially consumed the allowance,
 * before the re-read landed. Not a RevokeStage failure — the transaction succeeded — so it doesn't go through
 * revokeFailure; it's shown through the same failure/notice slot the row already has, deliberately, since that's
 * the row's only place for this kind of sentence.
 */
export const ALLOWANCE_STILL_SET = "The revoke went through, but an allowance is still set.";

/**
 * Where focus goes after a row disappears (its pair was just revoked): the row that now sits where it was — the
 * next one, shifted up, or the new last row when it was last — or the list's own landmark when none are left.
 */
export type FocusTarget = { kind: "row"; key: string } | { kind: "heading" };

export function focusTargetAfterRemoval(keysBefore: readonly string[], removedKey: string): FocusTarget {
  const idx = keysBefore.indexOf(removedKey);
  if (idx === -1) return { kind: "heading" };
  const remaining = keysBefore.filter((k) => k !== removedKey);
  if (remaining.length === 0) return { kind: "heading" };
  const key = idx < remaining.length ? remaining[idx] : remaining[remaining.length - 1];
  return { kind: "row", key };
}

/**
 * The Revoke button's accessible name, e.g. "Revoke USDC for Permit2" — the token by symbol, else its short
 * address; the spender by its resolved label, else "spender " plus its short address, matching inspectButtonLabel's
 * own wording for one Revoke doesn't recognise.
 */
export function revokeButtonLabel(row: Pick<Approval, "token" | "symbol" | "spender">, spenderName: string | null): string {
  const token = row.symbol ?? shortAddress(row.token);
  const spender = spenderName ?? `spender ${shortAddress(row.spender)}`;
  return `Revoke ${token} for ${spender}`;
}

/** The Inspect button's accessible name for an unlabelled spender, e.g. "Inspect spender 0x12…abcd". */
export function inspectButtonLabel(spender: Address): string {
  return `Inspect spender ${shortAddress(spender)}`;
}
