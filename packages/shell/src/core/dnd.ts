import type { DropKind } from "./manifest";

/** The four kinds of approval Revoke lists: an ERC-20 allowance, one NFT's approval, an operator, a Permit2 allowance. */
export type ApprovalDragKind = "erc20" | "erc721" | "operator" | "permit2";

export type DragItem =
  | { kind: "token"; address: string; symbol: string; decimals: number }
  /**
   * One of Revoke's rows. It names the row only: the window it lands on looks the row up in its own list and revokes
   * that, never a transaction built from what the drag claimed. `tokenId` is set for an "erc721" approval alone.
   */
  | { kind: "approval"; approval: ApprovalDragKind; token: string; spender: string; tokenId?: string };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** A uint256 in decimal: at most 78 digits, no sign, no leading zero (except 0 itself). */
const UINT = /^(0|[1-9][0-9]{0,77})$/;
const MAX_UINT256 = 2n ** 256n - 1n;
const APPROVAL_KINDS: readonly string[] = ["erc20", "erc721", "operator", "permit2"] satisfies ApprovalDragKind[];

export const dndMime = (kind: DropKind): string => `application/x-arcos-${kind}+json`;

export function encodeDragItem(item: DragItem): { mime: string; data: string } {
  return { mime: dndMime(item.kind), data: JSON.stringify(item) };
}

/** Dropped data can come from any page. Validate every field. */
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
  if (typeof o.address !== "string" || !ADDRESS.test(o.address)) return null;
  if (typeof o.symbol !== "string") return null;
  if (typeof o.decimals !== "number" || !Number.isInteger(o.decimals) || o.decimals < 0 || o.decimals > 36) {
    return null;
  }
  return { kind: "token", address: o.address, symbol: o.symbol.slice(0, 32), decimals: o.decimals };
}

function decodeApproval(o: Record<string, unknown>): DragItem | null {
  if (typeof o.approval !== "string" || !APPROVAL_KINDS.includes(o.approval)) return null;
  if (typeof o.token !== "string" || !ADDRESS.test(o.token)) return null;
  if (typeof o.spender !== "string" || !ADDRESS.test(o.spender)) return null;
  const approval = o.approval as ApprovalDragKind;
  if (approval !== "erc721") return { kind: "approval", approval, token: o.token, spender: o.spender };
  if (typeof o.tokenId !== "string" || !UINT.test(o.tokenId) || BigInt(o.tokenId) > MAX_UINT256) return null;
  return { kind: "approval", approval, token: o.token, spender: o.spender, tokenId: o.tokenId };
}

/** First accepted kind present in a DataTransfer type list (the only thing readable during dragover). */
export function acceptedKind(types: readonly string[], accepts: readonly DropKind[]): DropKind | null {
  for (const kind of accepts) if (types.includes(dndMime(kind))) return kind;
  return null;
}

/** The address a drag carries as plain text, for a drop outside the desktop: the token's. */
export function dragText(item: DragItem): string {
  return item.kind === "token" ? item.address : item.token;
}

// Only `token` is emitted: consumers (Inspector, Drop) re-read symbol/decimals on-chain rather
// than trusting whatever the dragged item claimed, so there's nothing else for a window param to
// carry. An approval names its token the same way.
export function dropParams(item: DragItem): Record<string, string> {
  return { token: dragText(item) };
}
