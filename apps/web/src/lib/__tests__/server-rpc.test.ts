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
