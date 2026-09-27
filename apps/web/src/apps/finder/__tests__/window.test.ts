import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EURC, USDC } from "@arcos/chain";
import type { TokenBalance } from "@arcos/inspector";

// The window reads the account from wagmi and the holdings from React Query; these tests only need
// their answers. Nothing here reaches the network.
const state = vi.hoisted(() => ({ address: undefined as string | undefined, holdings: [] as TokenBalance[] }));
vi.mock("wagmi", () => ({
  useAccount: () => ({ address: state.address }),
  useReadContract: () => ({ data: undefined, isLoading: false }),
  useReadContracts: () => ({ data: undefined }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: state.holdings, isLoading: false, isError: false }),
}));
vi.mock("@arcos/shell", () => ({ useDesktop: () => ({ open: () => true }), dragSourceProps: () => ({ draggable: true }) }));
vi.mock("@/components/ConnectGate", () => ({ ConnectGate: ({ children }: { children: unknown }) => children }));

import FinderWindow from "../Window";

const ACCOUNT = "0x000000000000000000000000000000000000dEaD";
const holding = (address: string, symbol: string): TokenBalance => ({ address, name: symbol, symbol, decimals: 18, value: 1n });
const at = (i: number) => `0x${i.toString(16).padStart(40, "0")}`;

beforeEach(() => {
  state.address = ACCOUNT;
  state.holdings = [
    ...Array.from({ length: 1000 }, (_, i) => holding(at(i + 1), `T${String(i).padStart(4, "0")}`)),
    holding(EURC.testnet, "EURC"),
    holding(USDC, "USDC"),
  ];
});

describe("Finder, with more tokens than it draws at once", () => {
  it("draws the first 200 and announces the count as a status", () => {
    const html = renderToStaticMarkup(createElement(FinderWindow));
    expect(html.match(/<li>/g)).toHaveLength(200);
    expect(html).toMatch(/<span[^>]*role="status"[^>]*>Showing 200 of 1,002 tokens<\/span>/);
    expect(html).toMatch(/<button[^>]*>Show more<\/button>/);
  });
});
