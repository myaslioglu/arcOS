import { afterEach, describe, expect, it, vi } from "vitest";
import { endpointHealth } from "@arcos/inspector";

// A marker module that throws outside a server build; these tests only need what watch-deps.ts builds.
vi.mock("server-only", () => ({}));

import { processGlobal } from "../process-global";
import { authRpcClient, serverRpcClient, watchRpcClient } from "../server-rpc";
import { watchDeps } from "../watch-deps";

// POST /api/watches runs one eth_getCode at an address the signed-in wallet chose. It goes through Watchdog's own RPC
// client, whose failures cool only its own endpoint-health record, never the one the Inspector, /api/pulse, /badge and
// /t share, nor sign-in's; and the read is capped at 5 s, so a stalled endpoint never holds the route.

/** Not a real address: the stubbed RPC answers whatever the test says about it. */
const ADDRESS = `0x${"ab".repeat(20)}` as const;

const inspectHealth = () => processGlobal("inspect.rpcHealth", endpointHealth);
const authHealth = () => processGlobal("auth.rpcHealth", endpointHealth);
const watchHealth = () => processGlobal("watch.rpcHealth", endpointHealth);

/** An RPC whose every endpoint answers eth_getCode with `code`, echoing the request's id. */
const rpcAnswering = (code: string) =>
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { id } = JSON.parse(String(init?.body)) as { id: number };
    return Response.json({ jsonrpc: "2.0", id, result: code });
  });

describe("Watchdog's RPC client and hasCode", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const health of [inspectHealth(), authHealth(), watchHealth()]) {
      health.coolingUntil.clear();
      health.failedAt.clear();
    }
  });

  it("is one per process, and neither sign-in's nor the shared server client", () => {
    expect(watchRpcClient()).toBe(watchRpcClient());
    expect(watchRpcClient()).not.toBe(authRpcClient());
    expect(watchRpcClient()).not.toBe(serverRpcClient());
    expect(watchDeps()).toBe(watchDeps());
  });

  it("an endpoint failing on eth_getCode cools Watchdog's own record, not sign-in's nor the shared inspect one", async () => {
    vi.stubGlobal("fetch", async () => new Response("unavailable", { status: 503 }));
    expect(watchHealth().coolingUntil.size).toBe(0);
    await expect(watchDeps().hasCode(ADDRESS)).rejects.toThrow();
    expect(watchHealth().coolingUntil.size).toBeGreaterThan(0);
    expect(authHealth().coolingUntil.size).toBe(0);
    expect(inspectHealth().coolingUntil.size).toBe(0);
  });

  it("reads the node's 0x as no contract, and bytecode as one", async () => {
    rpcAnswering("0x");
    expect(await watchDeps().hasCode(ADDRESS)).toBe(false);
    rpcAnswering("0x6080604052");
    expect(await watchDeps().hasCode(ADDRESS)).toBe(true);
    expect(watchHealth().coolingUntil.size).toBe(0);
  });

  it("reads the client's undefined and a literal 0x as no contract", async () => {
    const getCode = vi.spyOn(watchRpcClient(), "getCode");
    getCode.mockResolvedValueOnce(undefined);
    expect(await watchDeps().hasCode(ADDRESS)).toBe(false);
    getCode.mockResolvedValueOnce("0x");
    expect(await watchDeps().hasCode(ADDRESS)).toBe(false);
    getCode.mockResolvedValueOnce("0x00");
    expect(await watchDeps().hasCode(ADDRESS)).toBe(true);
    expect(getCode).toHaveBeenCalledTimes(3);
    expect(getCode).toHaveBeenLastCalledWith({ address: ADDRESS });
  });

  it("gives up after 5 s on a read that never answers", async () => {
    vi.useFakeTimers();
    vi.spyOn(watchRpcClient(), "getCode").mockReturnValue(new Promise(() => {}));
    let settled = false;
    const outcome = watchDeps()
      .hasCode(ADDRESS)
      .then(
        () => "answered",
        (e: Error) => e.name,
      )
      .finally(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await outcome).toBe("InspectionTimeout");
  });
});
