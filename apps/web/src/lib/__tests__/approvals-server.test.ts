import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, getAddress, pad, parseAbi, type Address, type Hex } from "viem";

// The real module is server-only; stub it the way pulse-server.test.ts does, so the module can load under vitest.
vi.mock("server-only", () => ({}));

// Revoke's own RPC client, mocked here: this file checks that cachedApprovals reads it (and only it), never the
// Inspector's serverRpcClient, and it never touches a real network. Its readContract serves the multicall and the
// canary alike; getBlockNumber (eth_blockNumber) is what the canary used to read, and must stay unused.
const { readContract, getBlockNumber, approvalsRpcClient, serverRpcClient } = vi.hoisted(() => ({
  readContract: vi.fn(),
  getBlockNumber: vi.fn(),
  approvalsRpcClient: vi.fn(() => ({ readContract, getBlockNumber })),
  serverRpcClient: vi.fn(() => {
    throw new Error("cachedApprovals must not read the Inspector's shared RPC client");
  }),
}));
vi.mock("../server-rpc", () => ({
  approvalsRpcClient,
  serverRpcClient,
  explorerPacer: () => () => Promise.resolve(),
}));

// The real chain, which one test swaps for a copy without Multicall3.
const { activeChain } = vi.hoisted(() => ({ activeChain: vi.fn() }));
vi.mock("@arcos/chain", async (importOriginal) => {
  const real = await importOriginal<typeof import("@arcos/chain")>();
  activeChain.mockImplementation(real.activeChain);
  return { ...real, activeChain };
});

import { cachedApprovals } from "../approvals-server";

const APPROVAL_TOPIC = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const TOKEN: Address = "0x3333333333333333333333333333333333333333";
const SPENDER: Address = "0x5555555555555555555555555555555555555555";
const str = (s: string): Hex => encodeAbiParameters([{ type: "string" }], [s]);
const topic = (a: Address): Hex => pad(a.toLowerCase() as Hex, { size: 32 });

/** The chain's Multicall3, which the multicall and the canary both read. */
const multicall3 = (): Address => {
  const address = activeChain().contracts?.multicall3?.address;
  if (!address) throw new Error("the active chain has no Multicall3");
  return address;
};
type Read = { address: Address; functionName: string };
/** What the client was asked to read, told apart by function: the multicall's aggregate3 calls, and the canary. */
const readsOf = (functionName: string): Read[] =>
  (readContract.mock.calls as [Read][]).map(([args]) => args).filter((args) => args.functionName === functionName);
const aggregateCalls = () => readsOf("aggregate3");
const canaryReads = () => readsOf("getBlockNumber");

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

/** One Approval log for `owner`, naming any token and spender, distinguished by `block` so a set of them never dedupes. */
function approvalLogFor(owner: Address, token: Address, spender: Address, block: number) {
  return {
    address: token,
    topics: [APPROVAL_TOPIC, topic(owner), topic(spender), null],
    data: pad("0x01", { size: 32 }),
    blockNumber: `0x${block.toString(16)}`,
    logIndex: "0x",
    transactionHash: `0x${block.toString(16).padStart(64, "0")}`,
    timeStamp: "0x0",
  };
}

describe("cachedApprovals", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    readContract.mockReset();
    getBlockNumber.mockReset();
    getBlockNumber.mockResolvedValue(1n); // the RPC is up unless a test says otherwise
    approvalsRpcClient.mockClear();
    serverRpcClient.mockClear();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("BLOCKSCOUT_API_KEY", "proapi_k");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("reads the multicall through approvalsRpcClient(), never the Inspector's shared serverRpcClient(): one aggregate3 call and no canary call for a clean lookup", async () => {
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
    expect(readContract).toHaveBeenCalledTimes(1);
    expect(readContract.mock.calls[0][0]).toMatchObject({ functionName: "aggregate3" });
    expect(canaryReads()).toEqual([]);
    expect(getBlockNumber).not.toHaveBeenCalled();
  });

  it("asks Multicall3 for the block number, on Revoke's own client and the multicall's own eth_call path, once, when the first aggregate3 call fails, and answers what it has, truncated, when that read answers (review N1 ruling)", async () => {
    const owner: Address = "0x8888888888888888888888888888888888888888";
    fetchMock.mockResolvedValue(logsResponse([approvalLog(owner)]));
    readContract.mockImplementation(async (args: Read) => {
      if (args.functionName === "getBlockNumber") return 1n; // the RPC answers
      throw new Error("out of gas"); // the owner's only token is poisoned
    });

    await expect(cachedApprovals(owner)).resolves.toEqual({ approvals: [], truncated: true });

    // Multicall3's own getBlockNumber(): no arguments, so nothing an attacker chose can poison it, and an eth_call like
    // the aggregate3 calls, where eth_blockNumber might be answered by another backend behind the same gateway.
    const abi = parseAbi(["function getBlockNumber() view returns (uint256)"]);
    expect(canaryReads()).toEqual([{ address: multicall3(), abi, functionName: "getBlockNumber" }]);
    expect(aggregateCalls().length).toBeGreaterThan(1); // the canary answered, so the halving went on
    expect(getBlockNumber).not.toHaveBeenCalled();
    expect(serverRpcClient).not.toHaveBeenCalled();
  });

  it("rejects, so the route answers 503, when the first aggregate3 call fails and the block number can't be read either: the RPC is down (review N1 ruling)", async () => {
    const owner: Address = "0x9999999999999999999999999999999999999999";
    fetchMock.mockResolvedValue(logsResponse([approvalLog(owner)]));
    readContract.mockRejectedValue(new Error("fetch failed")); // every read fails, the canary's included

    await expect(cachedApprovals(owner)).rejects.toMatchObject({ name: "ApprovalsUnavailable" });

    expect(aggregateCalls()).toHaveLength(1); // an outage is never split and retried
    expect(canaryReads()).toHaveLength(1);
    expect(getBlockNumber).not.toHaveBeenCalled();
  });

  it("answers 503 at once on a chain without Multicall3, sending no explorer request and no RPC read: the multicall and the canary (itself a Multicall3 read) have nothing to call", async () => {
    const owner: Address = "0xcccccccccccccccccccccccccccccccccccccccc";
    activeChain.mockReturnValueOnce({ ...activeChain(), contracts: {} });
    fetchMock.mockResolvedValue(logsResponse([approvalLog(owner)]));

    await expect(cachedApprovals(owner)).rejects.toMatchObject({ name: "ApprovalsUnavailable" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(readContract).not.toHaveBeenCalled();
    expect(getBlockNumber).not.toHaveBeenCalled();
  });

  it("sends no canary read once the route's 15 s deadline has aborted the lookup, even when the first aggregate3 call fails only after it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const owner: Address = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    fetchMock.mockResolvedValue(logsResponse([approvalLog(owner)]));
    readContract.mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(new Error("slow poison")), 16_000)));

    const outcome: { settled: unknown } = { settled: undefined };
    cachedApprovals(owner).then(
      (v) => (outcome.settled = v),
      (e: unknown) => (outcome.settled = e),
    );

    await vi.advanceTimersByTimeAsync(15_500);
    expect(outcome.settled).toMatchObject({ name: "InspectionTimeout" }); // the route has answered 503
    expect(readContract).toHaveBeenCalledTimes(1); // the first call is still in flight
    await vi.advanceTimersByTimeAsync(4_500); // it fails at 16 s, after the abort

    expect(readContract).toHaveBeenCalledTimes(1);
    expect(canaryReads()).toEqual([]);
    expect(getBlockNumber).not.toHaveBeenCalled();
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

  // Rebuilt for fix round 3 (task-8-fix-3.md), retimed for fix round 4. Faking only setTimeout/clearTimeout leaves
  // the lookup's own clock (performance.now) on real time, a few milliseconds over this whole test, so neither time
  // budget can fire on its own; only the route's setTimeout-driven 15 s deadline (and the abort it triggers) can stop
  // the attempts here. That makes the aggregate's abort check the thing under test: in production, with one clock,
  // MULTICALL_TIME_BUDGET_MS stops every attempt but the first long before the deadline, and the check is a backstop.
  it("stops the multicall's attempts at once when the route's 15 s deadline aborts it, isolated from both time budgets by leaving the lookup's clock unfaked (review 2b rebuild)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const owner: Address = "0x4444444444444444444444444444444444444444";
    const TOKEN_B: Address = "0x6666666666666666666666666666666666666666";
    const SPENDER_Y: Address = "0x7777777777777777777777777777777777777777";
    // 3 pairs over 2 tokens: every attempt fails, and the canary says the RPC is up, so the halving needs all
    // MULTICALL_BUDGET = 16 attempts to exhaust. At 1.1 s an attempt, the 14th starts at 14.3 s and the 15th would
    // start at 15.4 s, after the deadline: 14 attempts with the abort check, 16 (to 17.6 s) without it, and no attempt
    // lands on the deadline's own instant, so the count never hangs on a same-instant timer tie.
    fetchMock.mockResolvedValue(
      logsResponse([
        approvalLogFor(owner, TOKEN, SPENDER, 5),
        approvalLogFor(owner, TOKEN, SPENDER_Y, 6),
        approvalLogFor(owner, TOKEN_B, SPENDER, 7),
      ]),
    );
    readContract.mockImplementation((args: Read) =>
      args.functionName === "getBlockNumber"
        ? Promise.resolve(1n) // the canary: the RPC is up
        : new Promise((_, reject) => setTimeout(() => reject(new Error("slow poison")), 1_100)),
    );

    const outcome: { settled: unknown } = { settled: undefined };
    cachedApprovals(owner).then(
      (v) => (outcome.settled = v),
      (e: unknown) => (outcome.settled = e),
    );

    await vi.advanceTimersByTimeAsync(20_000);
    expect(outcome.settled).toMatchObject({ name: "InspectionTimeout" });
    expect(canaryReads()).toHaveLength(1);
    expect(getBlockNumber).not.toHaveBeenCalled();
    const countAfterDeadline = aggregateCalls().length;
    expect(countAfterDeadline).toBe(14);

    await vi.advanceTimersByTimeAsync(20_000); // plenty more simulated time, if anything were still driving it
    expect(aggregateCalls().length).toBe(countAfterDeadline); // not even one more attempt followed the abort
  });
});
