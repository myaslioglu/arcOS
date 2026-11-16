// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Position, PositionsAnswer } from "@/lib/positions";

/** Finder's Positions section, mounted in jsdom with its list answered from `state`: nothing reaches a chain. */

const state = vi.hoisted(() => ({
  answer: undefined as PositionsAnswer | undefined,
  pending: false,
  error: false,
  dragged: [] as unknown[],
  opened: [] as Array<[string, Record<string, string> | undefined]>,
}));
vi.mock("@arcos/shell", () => ({
  useDesktop: () => ({ open: (id: string, params?: Record<string, string>) => (state.opened.push([id, params]), true) }),
  dragSourceProps: (item: unknown) => (state.dragged.push(item), { draggable: true }),
}));
vi.mock("@/lib/usePositions", () => ({
  usePositions: () => ({ data: state.answer, isPending: state.pending, isError: state.error }),
}));

import { PositionFiles, positionKey } from "../Positions";

const OWNER = "0x7e57000000000000000000000000000000000001";
const FACTORY = "0x2aA12f98795E7A65072950AfbA9d1E023D398241";
const V4 = "0x6049c9a0e26405C0985f9E3685C87d0aE917f82B";
const position = (tokenId: string, over: Partial<Position> = {}): Position => ({
  manager: V4,
  managerName: "Uniswap v4",
  kind: "v4",
  tokenId,
  currency0: "0x0000000000000000000000000000000000000000",
  currency1: "0xBFF22091be481B41C8CA49862653aBA216bAc041",
  symbol0: "USDC",
  symbol1: "VTB",
  fee: 3000,
  liquidity: 1n,
  owed: false,
  hooks: null,
  ...over,
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const onSelect = vi.fn();
async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(PositionFiles, { owner: OWNER, factory: FACTORY, selected: null, onSelect })));
}

beforeEach(() => {
  state.answer = { managers: [], positions: [], notes: [] };
  state.pending = false;
  state.error = false;
  state.dragged = [];
  state.opened = [];
  onSelect.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("Finder's Positions section", () => {
  it("draws each position as a file that drags as an lp-position, marks one the factory would refuse, and double-clicks into Vault", async () => {
    state.answer = { managers: [], positions: [position("328649"), position("328650", { hooks: "0x0000000000000000000000000000000000A00800" })], notes: [] };
    await mount();
    const tiles = [...host.querySelectorAll("li button")] as HTMLButtonElement[];
    expect(tiles.map((t) => t.textContent)).toEqual(["#328649Uniswap v4USDC/VTB · 0.3%", "#328650Uniswap v4USDC/VTB · 0.3%Can't be locked"]);
    expect(tiles[1]?.title).toBe("This position is in a Uniswap v4 pool with hooks, which can't be locked.");
    expect(state.dragged).toEqual([
      { kind: "lp-position", manager: V4, tokenId: "328649" },
      { kind: "lp-position", manager: V4, tokenId: "328650" },
    ]);
    await act(async () => tiles[0]!.click());
    expect(onSelect).toHaveBeenCalledWith(position("328649"));
    await act(async () => tiles[0]!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(state.opened).toEqual([["vault", { manager: V4, tokenId: "328649" }]]);
    expect(positionKey(position("1"))).toBe(`${V4.toLowerCase()}:1`);
  });

  it("says when the list may be short, and how to lock one that isn't listed", async () => {
    state.answer = { managers: [], positions: [position("1")], notes: [{ manager: V4, name: "Uniswap v4", source: "recent", complete: false }] };
    await mount();
    expect(host.textContent).toContain("Uniswap v4: the explorer didn't answer, so only positions received in the last few minutes are listed. To lock another, type its id in Vault.");
  });

  it("says when there is nothing, while it reads, and when it couldn't read", async () => {
    await mount();
    expect(host.textContent).toContain("No Uniswap positions in the managers Vault takes.");
    await act(async () => root.unmount());
    state.pending = true;
    await mount();
    expect(host.textContent).toContain("Reading your positions…");
    await act(async () => root.unmount());
    state.pending = false;
    state.error = true;
    await mount();
    expect(host.textContent).toContain("Couldn't read your positions. To lock one, type its id in Vault.");
  });
});
