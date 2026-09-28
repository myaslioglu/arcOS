import { describe, expect, it, vi } from "vitest";

// A marker module that throws outside a server build; these tests only need what server-rpc.ts builds.
vi.mock("server-only", () => ({}));

import { processGlobal } from "../process-global";
import { explorerPacer, serverRpcClient } from "../server-rpc";

describe("server-rpc", () => {
  it("keeps one RPC client per process", () => {
    expect(serverRpcClient()).toBe(serverRpcClient());
  });

  it("hands every route the Inspector's explorer pacer", () => {
    const pacer = explorerPacer();
    expect(processGlobal("inspect.explorerPacer", () => () => Promise.resolve())).toBe(pacer);
    expect(explorerPacer()).toBe(pacer);
  });
});
