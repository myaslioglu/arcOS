import type { DropKind } from "./manifest";

export type DragItem = { kind: "token"; address: string; symbol: string; decimals: number };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

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
  if (o.kind !== kind || kind !== "token") return null;
  if (typeof o.address !== "string" || !ADDRESS.test(o.address)) return null;
  if (typeof o.symbol !== "string") return null;
  if (typeof o.decimals !== "number" || !Number.isInteger(o.decimals) || o.decimals < 0 || o.decimals > 36) {
    return null;
  }
  return { kind: "token", address: o.address, symbol: o.symbol.slice(0, 32), decimals: o.decimals };
}

/** First accepted kind present in a DataTransfer type list (the only thing readable during dragover). */
export function acceptedKind(types: readonly string[], accepts: readonly DropKind[]): DropKind | null {
  for (const kind of accepts) if (types.includes(dndMime(kind))) return kind;
  return null;
}

// Only `token` is emitted: consumers (Inspector, Drop) re-read symbol/decimals on-chain rather
// than trusting whatever the dragged item claimed, so there's nothing else for a window param to
// carry.
export function dropParams(item: DragItem): Record<string, string> {
  return { token: item.address };
}
