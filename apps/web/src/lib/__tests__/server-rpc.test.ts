import { describe, expect, it, vi } from "vitest";

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

  it("gives Revoke's RPC client its own endpoint-health record, so a spoofed approval's failures can't cool the Inspector's endpoints", () => {
    approvalsRpcClient();
    serverRpcClient();
    const revokeHealth = processGlobal("approvals.rpcHealth", endpointHealth);
    const inspectorHealth = processGlobal("inspect.rpcHealth", endpointHealth);
    expect(revokeHealth).not.toBe(inspectorHealth);
  });
});
