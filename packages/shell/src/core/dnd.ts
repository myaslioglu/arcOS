import type { DropKind } from "./manifest";

/** The four kinds of approval Revoke lists: an ERC-20 allowance, one NFT's approval, an operator, a Permit2 allowance. */
export type ApprovalDragKind = "erc20" | "erc721" | "operator" | "permit2";

export type DragItem =
  | { kind: "token"; address: string; symbol: string; decimals: number }
  /**
   * One of Revoke's rows. It names the row only: the window it lands on looks the row up in its own list and revokes
   * that, never a transaction built from what the drag claimed. `tokenId` is set for an "erc721" approval alone.
   */
  | { kind: "approval"; approval: ApprovalDragKind; token: string; spender: string; tokenId?: string }
  /**
   * A liquidity position NFT (Uniswap v3 or v4): the manager contract that issued it and its id, in decimal. It names
   * the position only: the window it lands on reads the position on chain before it offers anything.
   */
  | { kind: "lp-position"; manager: string; tokenId: string }
  /** One of Vault's locks: the vault contract's address. The window it lands on reads the vault on chain. */
  | { kind: "lock"; address: string };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** A uint256 in decimal: at most 78 digits, no sign, no leading zero (except 0 itself). */
const UINT = /^(0|[1-9][0-9]{0,77})$/;
const MAX_UINT256 = 2n ** 256n - 1n;
const APPROVAL_KINDS: readonly string[] = ["erc20", "erc721", "operator", "permit2"] satisfies ApprovalDragKind[];

const isAddress = (v: unknown): v is string => typeof v === "string" && ADDRESS.test(v);
const isUint256 = (v: unknown): v is string => typeof v === "string" && UINT.test(v) && BigInt(v) <= MAX_UINT256;

export const dndMime = (kind: DropKind): string => `application/x-arcos-${kind}+json`;

export function encodeDragItem(item: DragItem): { mime: string; data: string } {
  return { mime: dndMime(item.kind), data: JSON.stringify(item) };
}

/** Dropped data can come from any page. Validate every field, and keep only the fields each kind has. */
export function decodeDragItem(kind: DropKind, raw: string): DragItem | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const o = value as Record<string, unknown>;
  if (o.kind !== kind) return null;
  if (kind === "approval") return decodeApproval(o);
  if (kind === "lp-position") return decodePosition(o);
  if (kind === "lock") return isAddress(o.address) ? { kind: "lock", address: o.address } : null;
  if (!isAddress(o.address)) return null;
  if (typeof o.symbol !== "string") return null;
  if (typeof o.decimals !== "number" || !Number.isInteger(o.decimals) || o.decimals < 0 || o.decimals > 36) {
    return null;
  }
  return { kind: "token", address: o.address, symbol: o.symbol.slice(0, 32), decimals: o.decimals };
}

function decodeApproval(o: Record<string, unknown>): DragItem | null {
  if (typeof o.approval !== "string" || !APPROVAL_KINDS.includes(o.approval)) return null;
  if (!isAddress(o.token)) return null;
  if (!isAddress(o.spender)) return null;
  const approval = o.approval as ApprovalDragKind;
  if (approval !== "erc721") return { kind: "approval", approval, token: o.token, spender: o.spender };
  if (!isUint256(o.tokenId)) return null;
  return { kind: "approval", approval, token: o.token, spender: o.spender, tokenId: o.tokenId };
}

function decodePosition(o: Record<string, unknown>): DragItem | null {
  if (!isAddress(o.manager) || !isUint256(o.tokenId)) return null;
  return { kind: "lp-position", manager: o.manager, tokenId: o.tokenId };
}

/** First accepted kind present in a DataTransfer type list (the only thing readable during dragover). */
export function acceptedKind(types: readonly string[], accepts: readonly DropKind[]): DropKind | null {
  for (const kind of accepts) if (types.includes(dndMime(kind))) return kind;
  return null;
}

/**
 * What a drag carries as plain text, for a drop outside the desktop: a token's address, an approval's token, a lock's
 * vault, and a position as `<manager>#<id>`.
 */
export function dragText(item: DragItem): string {
  switch (item.kind) {
    case "token":
      return item.address;
    case "approval":
      return item.token;
    case "lp-position":
      return `${item.manager}#${item.tokenId}`;
    case "lock":
      return item.address;
  }
}

/**
 * The params a drop on an app's icon opens it with: what names the thing, nothing it claims about it. Consumers
 * (Inspector, Drop, Vault) re-read symbols, decimals and positions on chain rather than trust the dragged item, so a
 * token (or an approval) gives its `token`, a position its `manager` and `tokenId`, and a lock its `vault`.
 */
export function dropParams(item: DragItem): Record<string, string> {
  switch (item.kind) {
    case "lp-position":
      return { manager: item.manager, tokenId: item.tokenId };
    case "lock":
      return { vault: item.address };
    default:
      return { token: dragText(item) };
  }
}
