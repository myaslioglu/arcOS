import { afterEach, describe, expect, it, vi } from "vitest";

// A marker module that throws outside a server build; these tests only need what server-rpc.ts builds.
vi.mock("server-only", () => ({}));

import { processGlobal } from "../process-global";
import { endpointHealth } from "../rpc-transport";
import { approvalsRpcClient, explorerPacer, serverRpcClient } from "../server-rpc";

describe("server-rpc", () => {
  it("keeps one RPC client per process", () => {
    expect(serverRpcClient()).toBe(serverRpcClient());
  });

  it("hands every route the Inspector's explorer pacer", () => {
    const pacer = explorerPacer();
    expect(processGlobal("inspect.explorerPacer", () => () => Promise.resolve())).toBe(pacer);
    expect(explorerPacer()).toBe(pacer);
  });

  it("keeps one RPC client for Revoke too, separate from the Inspector's", () => {
    expect(approvalsRpcClient()).toBe(approvalsRpcClient());
    expect(approvalsRpcClient()).not.toBe(serverRpcClient());
  });

  // A v4 quote is an eth_call with a gas limit of its own, and a hostile pool can make it run out (Arc: -32003 "out of gas:
  // gas required exceeds: N"). That is the node's answer about one call: it must not cool the endpoints every inspection,
  // /badge, /t and /api/pulse share.
  describe("the Inspector's RPC client and an eth_call that runs out of gas", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      const health = processGlobal("inspect.rpcHealth", endpointHealth);
      health.coolingUntil.clear();
      health.failedAt.clear();
    });

    it("hands the out-of-gas answer back and cools nothing, asking no other endpoint", async () => {
      const health = processGlobal("inspect.rpcHealth", endpointHealth);
      let asked = 0;
      vi.stubGlobal("fetch", async () => {
        asked++;
        return Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32003, message: "out of gas: gas required exceeds: 2000000" } });
      });
      await expect(
        serverRpcClient().call({ to: "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94", data: "0x12345678", gas: 2_000_000n }),
      ).rejects.toThrow();
      expect(asked).toBe(1);
      expect(health.coolingUntil.size).toBe(0);
    });
  });

  // A test that only re-derives the same two processGlobal keys can't fail: it proves nothing about which record
  // approvalsRpcClient() actually wired in. This drives a real failure through it instead (review M-a).
  describe("Revoke's RPC client's endpoint-health isolation (review M-a)", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      const revokeHealth = processGlobal("approvals.rpcHealth", endpointHealth);
      revokeHealth.coolingUntil.clear();
      revokeHealth.failedAt.clear();
    });

    it("cools only Revoke's own endpoints when a request fails through approvalsRpcClient(), leaving the Inspector's record empty", async () => {
      const revokeHealth = processGlobal("approvals.rpcHealth", endpointHealth);
      const inspectorHealth = processGlobal("inspect.rpcHealth", endpointHealth);
      expect(inspectorHealth.coolingUntil.size).toBe(0); // the baseline this test actually checks against

      vi.stubGlobal("fetch", async () => new Response("unavailable", { status: 503 }));
      await expect(approvalsRpcClient().getBlockNumber()).rejects.toThrow();

      expect(revokeHealth.coolingUntil.size).toBeGreaterThan(0);
      expect(inspectorHealth.coolingUntil.size).toBe(0);
    });
  });
});
