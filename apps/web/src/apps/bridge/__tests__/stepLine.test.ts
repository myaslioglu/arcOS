import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeResult } from "@circle-fin/app-kit";

// A finished bridge's step list, rendered with a result whose approval the wallet rejected. Nothing reaches the network.
vi.mock("wagmi", () => ({
  useConnection: () => ({ address: "0x000000000000000000000000000000000000dEaD", connector: {} }),
  useBalance: () => ({ data: undefined }),
  useReadContract: () => ({ data: undefined }),
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: undefined }) }));
vi.mock("@arcos/shell", () => ({ useDesktop: () => ({ notify: () => {} }) }));
vi.mock("@/components/ConnectGate", () => ({ ConnectGate: ({ children }: { children: unknown }) => children }));

const RAW = "User rejected the request. Request Arguments: chain: Arc (id: 5042) from: 0x463A81a017326E9029DcCA2a2d9AA42599Bef12c";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
  vi.resetModules();
});
afterEach(() => vi.unstubAllEnvs());

describe("Bridge, the step list of a finished bridge", () => {
  it("shows the app's sentences for a rejected approval and a warning: no address, no request arguments, none of the SDK's text", async () => {
    const { session } = await import("../session");
    const { default: BridgeWindow } = await import("../Window");
    const chain = (name: string, chainId: number, symbol: string) => ({ chain: name, name, chainId, nativeCurrency: { name: symbol, symbol, decimals: 18 } });
    const result = {
      state: "error",
      amount: "1.0",
      token: "USDC",
      source: { chain: chain("Arc", 5042, "USDC"), adapter: {} },
      destination: { chain: chain("Base", 8453, "ETH"), adapter: {} },
      warnings: [{ code: "SPEED_DOWNGRADED", message: "Fast burn allowance exhausted for 0x463A81a017326E9029DcCA2a2d9AA42599Bef12c; degraded to SLOW" }],
      steps: [
        {
          name: "approve",
          state: "error",
          errorMessage: `Unknown blockchain error on Arc: ${RAW}`,
          error: { code: 5099, name: "ONCHAIN_UNKNOWN_BLOCKCHAIN_ERROR", message: RAW, cause: { trace: { rawError: { message: RAW, code: 4001 } } } },
        },
      ],
    } as unknown as BridgeResult;
    expect(session.start("Arc", "Base", "1", false)).toBe(true);
    session.finish(result);

    const html = renderToStaticMarkup(createElement(BridgeWindow));
    expect(html).toContain("approve: error");
    expect(html).toContain("Rejected in your wallet.");
    expect(html).not.toMatch(/Request Arguments/i);
    expect(html).not.toMatch(/0x463A/);
    expect(html).not.toContain("Unknown blockchain error");
    // The warning too: its code picks the app's sentence, its message (with an address) is never rendered.
    expect(html).toContain("slower route");
    expect(html).not.toContain("Fast burn allowance");
    session.dismiss();
  });
});
