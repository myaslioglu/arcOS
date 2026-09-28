import { describe, expect, it, vi } from "vitest";

// A stub RPC client in place of the server's: this test checks what pulse-server.ts asks it, and what it answers.
vi.mock("server-only", () => ({}));
const { getFeeHistory } = vi.hoisted(() => ({ getFeeHistory: vi.fn() }));
vi.mock("../server-rpc", () => ({ serverRpcClient: () => ({ getFeeHistory }) }));

import { cachedPulse } from "../pulse-server";

describe("cachedPulse", () => {
  it("asks the RPC client for the last 1,024 blocks' fee history, once for requests that arrive together", async () => {
    getFeeHistory.mockResolvedValue({ oldestBlock: 5000n, gasUsedRatio: [0.1, 0.123456], baseFeePerGas: [] });
    const [a, b] = await Promise.all([cachedPulse(), cachedPulse()]);
    expect(getFeeHistory).toHaveBeenCalledTimes(1);
    expect(getFeeHistory).toHaveBeenCalledWith({ blockCount: 1024, blockTag: "latest", rewardPercentiles: [] });
    expect(a).toEqual({ oldestBlock: 5000, ratios: [0.1, 0.1235] });
    expect(b).toBe(a);
  });
});
