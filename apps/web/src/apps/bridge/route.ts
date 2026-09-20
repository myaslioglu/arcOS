import type { ChainId } from "./chains";

export type Direction = "toArc" | "fromArc";

/** Resolves the direction toggle and the picked EVM chain into a source/destination pair. `arcChain`
 * is passed in (rather than imported) so this stays a pure function, trivially testable without
 * stubbing the network env var. */
export function resolveRoute(direction: Direction, otherChain: ChainId, arcChain: ChainId): { source: ChainId; dest: ChainId } {
  return direction === "toArc" ? { source: otherChain, dest: arcChain } : { source: arcChain, dest: otherChain };
}
