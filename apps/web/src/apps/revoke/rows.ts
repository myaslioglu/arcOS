import { getAddress, isAddress, parseAbi, type Address } from "viem";
import { cleanLabel } from "@arcos/inspector";
import type { DragItem } from "@arcos/shell";
import { formatTokenAmount } from "@/lib/amount";
import { isUnlimited, type Approval, type ApprovalKind, type ApprovalsAnswer } from "@/lib/approvals";
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

/** Half of Permit2's uint160 range: a Permit2 allowance this large or larger reads "Unlimited". */
const PERMIT2_UNLIMITED = 2n ** 159n;

/**
 * "Unlimited" at 2^255 or more (2^159 for a Permit2 allowance, whose amounts are uint160), else the amount at the
 * token's decimals; a token that didn't say its decimals shows raw units.
 */
export function allowanceText(allowance: string, decimals: number | null, kind: ApprovalKind = "erc20"): string {
  const value = BigInt(allowance);
  if (kind === "permit2" ? value >= PERMIT2_UNLIMITED : isUnlimited(value)) return "Unlimited";
  return decimals === null ? `${value.toString()} units` : formatTokenAmount(value, decimals);
}

/** What a row allows: an amount, one NFT ("NFT #7"), or a whole collection ("Every item"). */
export function approvalText(row: Pick<Approval, "kind" | "allowance" | "decimals" | "tokenId">): string {
  if (row.kind === "erc721") return `NFT #${row.tokenId ?? "?"}`;
  if (row.kind === "operator") return "Every item";
  return allowanceText(row.allowance, row.decimals, row.kind);
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^(0|[1-9][0-9]{0,77})$/;
const KINDS: readonly string[] = ["erc20", "erc721", "operator", "permit2"] satisfies ApprovalKind[];
const notAnAnswer = () => new Error("Not an approvals answer.");

/** /api/approvals' answer, checked field by field, labels cleaned again; anything else throws. */
export function parseApprovalsAnswer(json: unknown): ApprovalsAnswer {
  const o = typeof json === "object" && json !== null ? (json as { approvals?: unknown; truncated?: unknown }) : {};
  if (!Array.isArray(o.approvals) || typeof o.truncated !== "boolean") throw notAnAnswer();
  const approvals = o.approvals.map((raw): Approval => {
    const a = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    if (typeof a.kind !== "string" || !KINDS.includes(a.kind)) throw notAnAnswer();
    const kind = a.kind as ApprovalKind;
    if (typeof a.token !== "string" || !ADDRESS.test(a.token)) throw notAnAnswer();
    if (typeof a.spender !== "string" || !ADDRESS.test(a.spender)) throw notAnAnswer();
    if (typeof a.allowance !== "string" || !/^\d+$/.test(a.allowance)) throw notAnAnswer();
    if (typeof a.lastApprovalBlock !== "number" || !Number.isSafeInteger(a.lastApprovalBlock)) throw notAnAnswer();
    if (kind === "erc721" && (typeof a.tokenId !== "string" || !UINT.test(a.tokenId))) throw notAnAnswer();
    if (kind === "permit2" && a.expiration !== undefined && !(Number.isSafeInteger(a.expiration) && (a.expiration as number) >= 0)) {
      throw notAnAnswer();
    }
    const decimals =
      typeof a.decimals === "number" && Number.isInteger(a.decimals) && a.decimals >= 0 && a.decimals <= 255 ? a.decimals : null;
    return {
      kind,
      token: getAddress(a.token),
      symbol: typeof a.symbol === "string" ? cleanLabel(a.symbol, 32) : null,
      name: typeof a.name === "string" ? cleanLabel(a.name, 64) : null,
      decimals,
      spender: getAddress(a.spender),
      spenderLabel: typeof a.spenderLabel === "string" ? a.spenderLabel : null,
      allowance: a.allowance,
      ...(kind === "erc721" ? { tokenId: a.tokenId as string } : {}),
      ...(kind === "permit2" && a.expiration !== undefined ? { expiration: a.expiration as number } : {}),
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

/**
 * A row's key, whatever the case of its letters: an ERC-20 pair's is `token:spender` (as it always was, so a revoke
 * stored before the other kinds existed still counts), each other kind's starts with the kind, and an NFT's names its
 * id instead of the spender, since the NFT has one approval at a time whoever holds it.
 */
export const rowKey = (row: Pick<Approval, "token" | "spender"> & Partial<Pick<Approval, "kind" | "tokenId">>): string => {
  const kind = row.kind ?? "erc20";
  if (kind === "erc20") return `${row.token}:${row.spender}`.toLowerCase();
  if (kind === "erc721") return `erc721:${row.token}:${row.tokenId ?? ""}`.toLowerCase();
  return `${kind}:${row.token}:${row.spender}`.toLowerCase();
};

/** The drag item a row is dragged as: it names the row, nothing more (see `rowForDrop`). */
export function dragItemOf(row: Approval): DragItem {
  return {
    kind: "approval",
    approval: row.kind,
    token: row.token,
    spender: row.spender,
    ...(row.kind === "erc721" && row.tokenId !== undefined ? { tokenId: row.tokenId } : {}),
  };
}

/**
 * The listed row a dropped item names, or null. A drop can come from any page, so it is only ever a pointer into the
 * list the window already shows: what gets revoked is that row, never a transaction built from the drag's own fields.
 */
export function rowForDrop(rows: readonly Approval[], item: DragItem): Approval | null {
  if (item.kind !== "approval") return null;
  const key = rowKey({ kind: item.approval, token: item.token as Address, spender: item.spender as Address, tokenId: item.tokenId });
  return rows.find((r) => rowKey(r) === key && r.spender.toLowerCase() === item.spender.toLowerCase()) ?? null;
}

// Pairs revoked in this page, with the block each revoke landed in. The server keeps an owner's list for 60 s, so a
// window reopened in that time could list a pair that is already revoked; `stillLive` hides it until a newer approval
// of the same pair appears (a strictly higher lastApprovalBlock). Kept in memory for this page load, and, best
// effort, in sessionStorage under one key per owner (STORAGE_PREFIX + the lowercased owner) so a reload in the same
// tab keeps a revoked pair hidden too — the in-memory map alone would start empty again. Every storage access is
// wrapped in try/catch: a private window, storage the visitor blocked, or a server render with no `sessionStorage`
// at all (a ReferenceError, caught the same way) all fall back to memory only for that access.
const revokedAt = new Map<string, number>();
const STORAGE_PREFIX = "arcos-revoked:";
const storageKey = (owner: Address) => `${STORAGE_PREFIX}${owner.toLowerCase()}`;

// What comes back from storage is checked, not trusted: only a plain object's entries whose value is a non-negative
// safe integer count. Any other shape (a JSON null, an array, a string) reads as no revokes, and a bad entry beside
// good ones is dropped; left in, a null throws inside `stillLive`, and a non-numeric value hides its pair whatever
// the block.
function readStorage(owner: Address): Record<string, number> {
  try {
    const raw = sessionStorage.getItem(storageKey(owner));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const revokes: Record<string, number> = {};
    for (const [key, block] of Object.entries(parsed)) {
      if (Number.isSafeInteger(block) && block >= 0) revokes[key] = block;
    }
    return revokes;
  } catch {
    return {};
  }
}

function writeStorage(owner: Address, pairKey: string, block: number): void {
  try {
    const all = readStorage(owner);
    all[pairKey] = block;
    sessionStorage.setItem(storageKey(owner), JSON.stringify(all));
  } catch {
    // The in-memory revokedAt entry (set by markRevoked below, unconditionally) already covers this
    // page load; sessionStorage is a best-effort extra copy, never the only one.
  }
}

export function markRevoked(owner: Address, row: Pick<Approval, "token" | "spender">, block: number): void {
  revokedAt.set(`${owner.toLowerCase()}:${rowKey(row)}`, block);
  writeStorage(owner, rowKey(row), block);
}

export function stillLive(owner: Address, rows: readonly Approval[]): Approval[] {
  const stored = readStorage(owner);
  return rows.filter((row) => {
    const key = rowKey(row);
    const fromMemory = revokedAt.get(`${owner.toLowerCase()}:${key}`);
    const fromStorage = stored[key];
    const at =
      fromMemory === undefined ? fromStorage : fromStorage === undefined ? fromMemory : Math.max(fromMemory, fromStorage);
    return at === undefined || row.lastApprovalBlock > at;
  });
}

/**
 * Whether a node's answer of zero can be believed for a pair whose newest Approval event sits at `lastApprovalBlock`,
 * the block the explorer reported. A node whose head is behind that block hasn't seen the approval yet, so it can say 0
 * for an allowance that is live; only a node at or past the block can say the pair was revoked since. Window.tsx takes
 * its "already zero" shortcut only then, and otherwise goes on to the simulate and the wallet.
 */
export function nodeHasSeenApproval(head: bigint, lastApprovalBlock: number): boolean {
  return head >= BigInt(lastApprovalBlock);
}

/** Forgets every revoke this page made, in memory and in sessionStorage (for tests). */
export function forgetRevokes(): void {
  revokedAt.clear();
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(STORAGE_PREFIX)) sessionStorage.removeItem(k);
    }
  } catch {
    // Nothing to clear if storage isn't accessible.
  }
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
 * Where focus goes when a revoke run ends, from the keys listed when it started and how each row came out: back to
 * the first row that is still listed (it failed, or is still set) among those the run carried, else, for a single row
 * that was revoked, the row now in its place (`focusTargetAfterRemoval`), else the first row the run didn't touch,
 * else the list's own landmark.
 */
export function focusAfterRun(keysBefore: readonly string[], outcomes: readonly { key: string; result: string }[]): FocusTarget {
  const stays = outcomes.find((o) => o.result !== "revoked");
  if (stays) return { kind: "row", key: stays.key };
  const removed = new Set(outcomes.map((o) => o.key));
  if (removed.size === 1) return focusTargetAfterRemoval(keysBefore, [...removed][0]!);
  const next = keysBefore.find((k) => !removed.has(k));
  return next === undefined ? { kind: "heading" } : { kind: "row", key: next };
}

/**
 * Whether focus was lost: nothing holds it, or the page body does, which is where it lands when the element that had it
 * is removed (a revoked row) or disabled (the Revoke button that was clicked, while its revoke runs). Window.tsx moves
 * focus on when a revoke ends only then. A visitor who has moved on, to the Terminal, the lookup field or a window of
 * another app, keeps their place, so their next Space or Enter can't start a revoke they didn't choose.
 */
export function focusWasLost(active: object | null, body: object | null): boolean {
  return active === null || active === body;
}

/**
 * The Revoke button's accessible name, e.g. "Revoke USDC for Permit2" — the token by symbol, else its short
 * address; the spender by its resolved label, else "spender " plus its short address, matching inspectButtonLabel's
 * own wording for one Revoke doesn't recognise.
 */
export function revokeButtonLabel(
  row: Pick<Approval, "token" | "symbol" | "spender"> & Partial<Pick<Approval, "tokenId">>,
  spenderName: string | null,
): string {
  const name = row.symbol ?? shortAddress(row.token);
  const token = row.tokenId !== undefined ? `${name} #${row.tokenId}` : name;
  const spender = spenderName ?? `spender ${shortAddress(row.spender)}`;
  return `Revoke ${token} for ${spender}`;
}

/** The Inspect button's accessible name for an unlabelled spender, e.g. "Inspect spender 0x12…abcd". */
export function inspectButtonLabel(spender: Address): string {
  return `Inspect spender ${shortAddress(spender)}`;
}
