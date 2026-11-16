"use client";

import { Layers } from "lucide-react";
import type { Address } from "viem";
import { dragSourceProps, useDesktop } from "@arcos/shell";
import { noteText, pairText, positionIssue, type Position } from "@/lib/positions";
import { usePositions } from "@/lib/usePositions";

/** A position's key in the list, and Finder's selection. */
export const positionKey = (p: Pick<Position, "manager" | "tokenId">) => `${p.manager.toLowerCase()}:${p.tokenId}`;

/**
 * Finder's Positions section: the wallet's liquidity positions in the managers the VaultFactory allows (lib/positions.ts
 * says where each list comes from), each a file to drag onto Vault, or to double-click to lock it there. Shown only
 * on a network with a VaultFactory.
 */
export function PositionFiles({
  owner,
  factory,
  selected,
  onSelect,
}: {
  owner: Address;
  factory: Address;
  selected: string | null;
  onSelect: (p: Position) => void;
}) {
  const { open } = useDesktop();
  const positions = usePositions(owner, factory);
  const list = positions.data?.positions ?? [];
  const notes = (positions.data?.notes ?? []).map(noteText).filter((t): t is string => t !== null);

  return (
    <section className="mt-4" aria-label="Positions">
      <h3 className="px-1 pb-1 text-xs font-medium text-muted">Positions</h3>
      {positions.isPending ? (
        <p className="p-3 text-muted">Reading your positions…</p>
      ) : positions.isError ? (
        <p className="p-3 text-muted">{"Couldn't read your positions. To lock one, type its id in Vault."}</p>
      ) : list.length === 0 ? (
        <p className="p-3 text-muted">No Uniswap positions in the managers Vault takes.</p>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(128px,1fr))] gap-1">
          {list.map((p) => {
            const key = positionKey(p);
            const issue = positionIssue(p);
            return (
              <li key={key}>
                <button
                  type="button"
                  className="os-icon w-full"
                  aria-pressed={selected === key}
                  title={issue ?? undefined}
                  onClick={() => onSelect(p)}
                  onDoubleClick={() => open("vault", { manager: p.manager, tokenId: p.tokenId })}
                  {...dragSourceProps({ kind: "lp-position", manager: p.manager, tokenId: p.tokenId })}
                >
                  <span className="os-icon-tile os-icon-tile--sm">
                    <Layers size={16} aria-hidden />
                  </span>
                  <span className="os-icon-name">{`#${p.tokenId}`}</span>
                  <span className="block text-[10px] text-muted">{p.managerName}</span>
                  <span className="block truncate text-[11px]">{pairText(p)}</span>
                  {issue && <span className="block text-[11px] text-accent-3-text">{"Can't be locked"}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {notes.map((text) => (
        <p key={text} className="px-1 pt-2 text-xs text-muted">
          {text}
        </p>
      ))}
    </section>
  );
}
