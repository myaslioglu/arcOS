import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The window reads the account and the balances from wagmi, and the estimate from React Query; these tests only need
// their answers. Nothing here reaches the network or a wallet.
const state = vi.hoisted(() => ({
  address: undefined as string | undefined,
  nativeWei: undefined as bigint | undefined,
  erc20: undefined as bigint | undefined,
  reads: [] as { enabled: unknown; address: unknown }[],
}));
vi.mock("wagmi", () => ({
  useConnection: () => ({ address: state.address, connector: state.address ? {} : undefined }),
  useBalance: () => ({ data: state.nativeWei === undefined ? undefined : { value: state.nativeWei } }),
  useReadContract: (p: { address: unknown; query: { enabled: unknown } }) => {
    state.reads.push({ enabled: p.query.enabled, address: p.address });
    return { data: state.erc20 };
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined, status: "pending", error: null, isFetching: false }),
}));
vi.mock("@arcos/shell", () => ({ useDesktop: () => ({ notify: () => {} }) }));
vi.mock("@/components/ConnectGate", () => ({ ConnectGate: ({ children }: { children: unknown }) => children }));

import SwapWindow from "../Window";

const ACCOUNT = "0x000000000000000000000000000000000000dEaD";

beforeEach(() => {
  state.address = ACCOUNT;
  state.nativeWei = 4_835_553n * 10n ** 12n + 123n; // native USDC carries 18 decimals; the dust below 6 is dropped
  state.erc20 = undefined;
  state.reads = [];
});

describe("Swap, the balance of the token being sent", () => {
  it("shows the USDC balance (read natively, like the top bar) and a Max button under the amount", () => {
    const html = renderToStaticMarkup(createElement(SwapWindow));
    expect(html).toContain("Balance: 4.835553 USDC");
    expect(html).toMatch(/aria-label="Use the maximum amount of USDC"[^>]*>Max</);
    // USDC is native: the ERC-20 read is declared (hooks can't be conditional) but stays off.
    expect(state.reads.every((r) => r.enabled === false)).toBe(true);
  });

  it("shows nothing when no wallet is connected", () => {
    state.address = undefined;
    const html = renderToStaticMarkup(createElement(SwapWindow));
    expect(html).not.toContain("Balance:");
    expect(html).not.toContain(">Max<");
  });

  it("shows nothing while the balance is still loading", () => {
    state.nativeWei = undefined;
    expect(renderToStaticMarkup(createElement(SwapWindow))).not.toContain("Balance:");
  });
});
