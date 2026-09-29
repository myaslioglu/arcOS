import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, getAddress, pad, type Address, type Hex } from "viem";

// The real module is server-only; stub it the way pulse-server.test.ts does, so the module can load under vitest.
vi.mock("server-only", () => ({}));

// Revoke's own RPC client, mocked here: this file checks that cachedApprovals reads it (and only it), never the
// Inspector's serverRpcClient, and it never touches a real network.
const { readContract, approvalsRpcClient, serverRpcClient } = vi.hoisted(() => ({
  readContract: vi.fn(),
  approvalsRpcClient: vi.fn(() => ({ readContract })),
  serverRpcClient: vi.fn(() => {
    throw new Error("cachedApprovals must not read the Inspector's shared RPC client");
  }),
}));
vi.mock("../server-rpc", () => ({
  approvalsRpcClient,
  serverRpcClient,
  explorerPacer: () => () => Promise.resolve(),
}));

import { cachedApprovals } from "../approvals-server";

const APPROVAL_TOPIC = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const TOKEN: Address = "0x3333333333333333333333333333333333333333";
const SPENDER: Address = "0x5555555555555555555555555555555555555555";
const str = (s: string): Hex => encodeAbiParameters([{ type: "string" }], [s]);
const topic = (a: Address): Hex => pad(a.toLowerCase() as Hex, { size: 32 });

/** One Blockscout logs-module answer: `result` as its own list of raw logs. */
function logsResponse(result: unknown[]) {
  return new Response(JSON.stringify({ status: result.length ? "1" : "0", message: "OK", result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** One Approval log for `owner`, on TOKEN, naming SPENDER. */
function approvalLog(owner: Address) {
  return {
    address: TOKEN,
    topics: [APPROVAL_TOPIC, topic(owner), topic(SPENDER), null],
    data: pad("0x01", { size: 32 }),
    blockNumber: "0x5",
    logIndex: "0x",
    transactionHash: `0x${"1".repeat(64)}`,
    timeStamp: "0x0",
  };
}

describe("cachedApprovals", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    readContract.mockReset();
    approvalsRpcClient.mockClear();
    serverRpcClient.mockClear();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("BLOCKSCOUT_API_KEY", "proapi_k");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("reads the multicall through approvalsRpcClient(), never the Inspector's shared serverRpcClient()", async () => {
    const owner: Address = "0x1111111111111111111111111111111111111111";
    fetchMock.mockResolvedValue(logsResponse([approvalLog(owner)]));
    readContract.mockResolvedValue([
      { success: true, returnData: encodeAbiParameters([{ type: "uint256" }], [5n]) },
      { success: true, returnData: str("AAA") },
      { success: true, returnData: str("Token A") },
      { success: true, returnData: encodeAbiParameters([{ type: "uint8" }], [18]) },
    ]);

    const answer = await cachedApprovals(owner);

    expect(answer.approvals).toEqual([expect.objectContaining({ token: TOKEN, spender: SPENDER, allowance: "5", symbol: "AAA" })]);
    expect(approvalsRpcClient).toHaveBeenCalled();
    expect(serverRpcClient).not.toHaveBeenCalled();
    expect(readContract.mock.calls[0][0]).toMatchObject({ functionName: "aggregate3" });
  });

  it("lowercases the cache key, so a checksummed and a lowercase owner share one lookup", async () => {
    const owner = getAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(owner).not.toBe(owner.toLowerCase());
    fetchMock.mockResolvedValue(logsResponse([]));

    const first = await cachedApprovals(owner);
    const second = await cachedApprovals(owner.toLowerCase() as Address);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("sends the explorer key only as an Authorization: Bearer header, on the logs request, never in its URL", async () => {
    const owner: Address = "0x2222222222222222222222222222222222222222";
    fetchMock.mockResolvedValue(logsResponse([]));

    await cachedApprovals(owner);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).not.toContain("proapi_k");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer proapi_k");
  });
});
