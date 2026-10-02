import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The window reads the account and Arc's balance from wagmi, and the other chain's balance from React Query; these
// tests only need their answers. Nothing here reaches the network or a wallet.
const state = vi.hoisted(() => ({
  address: undefined as string | undefined,
  nativeWei: undefined as bigint | undefined,
  otherChain: undefined as bigint | undefined,
  queries: [] as { key: unknown[]; enabled: unknown }[],
}));
vi.mock("wagmi", () => ({
  useConnection: () => ({ address: state.address, connector: state.address ? {} : undefined }),
  useBalance: () => ({ data: state.nativeWei === undefined ? undefined : { value: state.nativeWei } }),
  useReadContract: () => ({ data: undefined }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (q: { queryKey: unknown[]; enabled: unknown }) => {
    state.queries.push({ key: q.queryKey, enabled: q.enabled });
    return { data: state.otherChain };
  },
}));
vi.mock("@arcos/shell", () => ({ useDesktop: () => ({ notify: () => {} }) }));
vi.mock("@/components/ConnectGate", () => ({ ConnectGate: ({ children }: { children: unknown }) => children }));

const ACCOUNT = "0x000000000000000000000000000000000000dEaD";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
  vi.resetModules();
  state.address = ACCOUNT;
  state.nativeWei = 4_835_553n * 10n ** 12n;
  state.otherChain = 0n;
  state.queries = [];
});
afterEach(() => vi.unstubAllEnvs());

const render = async () => {
  const { default: BridgeWindow } = await import("../Window");
  return renderToStaticMarkup(createElement(BridgeWindow));
};

describe("Bridge, the balance on the source chain", () => {
  it("opens on To Arc from Ethereum and shows the USDC held on Ethereum, read from that chain", async () => {
    const html = await render();
    expect(html).toContain("Balance: 0 USDC on Ethereum");
    expect(state.queries).toContainEqual({ key: ["bridge-source-balance", "Ethereum", ACCOUNT], enabled: true });
  });

  it("shows another chain's balance as that chain's read returns it", async () => {
    state.otherChain = 12_500_000n;
    expect(await render()).toContain("Balance: 12.5 USDC on Ethereum");
  });

  it("shows nothing when no wallet is connected", async () => {
    state.address = undefined;
    const html = await render();
    expect(html).not.toContain("Balance:");
    expect(state.queries.every((q) => q.enabled === false)).toBe(true);
  });
});
