import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeAbiParameters, erc20Abi, getAddress, pad, toEventSelector, type Address, type Hex } from "viem";
import { ARCOS, PERMIT2 } from "@arcos/chain";
import {
  APPROVAL_TOPIC,
  ApprovalsUnavailable,
  LOGS_PAGE,
  MAX_PAGES,
  EXPLORER_TIME_BUDGET_MS,
  MAX_PAIRS,
  MULTICALL_BUDGET,
  MULTICALL_TIME_BUDGET_MS,
  SWAP_ADAPTER,
  UNLIMITED,
  approvalPairs,
  collectApprovalLogs,
  isUnlimited,
  liveApprovals,
  loadApprovals,
  logsPageUrl,
  readLog,
  readLogsPage,
  spenderLabel,
  type Aggregate,
  type Canary,
  type ExplorerLog,
} from "../approvals";

const OWNER: Address = "0x1111111111111111111111111111111111111111";
const STRANGER: Address = "0x2222222222222222222222222222222222222222";
const TOKEN_A: Address = "0x3333333333333333333333333333333333333333";
const TOKEN_B: Address = "0x4444444444444444444444444444444444444444";
const SPENDER_X: Address = "0x5555555555555555555555555555555555555555";
const SPENDER_Y: Address = "0x6666666666666666666666666666666666666666";
const TRANSFER_TOPIC = toEventSelector("Transfer(address,address,uint256)");

const topic = (a: Address): Hex => pad(a.toLowerCase() as Hex, { size: 32 });
const txHash = (block: number, index: number) => `0x${(block * 1000 + index).toString(16).padStart(64, "0")}`;

/** One log as Blockscout's logs module sends it: hex numbers ("0x" for 0), topics padded with nulls to four. */
function rawLog(token: Address, spender: Address, block: number, index = 0, extra: (string | null)[] = [null], from: Address = OWNER) {
  return {
    address: token.toLowerCase(),
    topics: [APPROVAL_TOPIC, topic(from), topic(spender), ...extra],
    data: pad("0x01", { size: 32 }),
    blockNumber: `0x${block.toString(16)}`,
    logIndex: index === 0 ? "0x" : `0x${index.toString(16)}`,
    transactionHash: txHash(block, index),
    timeStamp: "0x0",
  };
}
const logOf = (raw: ReturnType<typeof rawLog>): ExplorerLog => readLog(raw)!;
const str = (s: string): Hex => encodeAbiParameters([{ type: "string" }], [s]);

/** A stub Multicall3: answers each ERC-20 call from `answers`, "revert" failing that call alone. */
function stubChain(answers: {
  allowance: (token: Address, spender: Address) => bigint | "revert";
  symbol?: (token: Address) => Hex | "revert";
  name?: (token: Address) => string | "revert";
  decimals?: (token: Address) => number | "revert";
}) {
  const batches: number[] = [];
  const aggregate: Aggregate = async (calls) => {
    batches.push(calls.length);
    return calls.map(({ target, callData }) => {
      const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: callData });
      const answer =
        functionName === "allowance"
          ? answers.allowance(target, (args as readonly [Address, Address])[1])
          : functionName === "symbol"
            ? (answers.symbol?.(target) ?? str("SYM"))
            : functionName === "name"
              ? (answers.name?.(target) ?? "Token")
              : functionName === "decimals"
                ? (answers.decimals?.(target) ?? 18)
                : "revert";
      if (answer === "revert") return { success: false, returnData: "0x" as Hex };
      const returnData =
        functionName === "allowance"
          ? encodeAbiParameters([{ type: "uint256" }], [answer as bigint])
          : functionName === "symbol"
            ? (answer as Hex)
            : functionName === "name"
              ? str(answer as string)
              : encodeAbiParameters([{ type: "uint8" }], [answer as number]);
      return { success: true, returnData };
    });
  };
  return { aggregate, batches };
}

/** A canary that answers (with a block number): the RPC is up, so a failed aggregate call failed on its own. */
const rpcUp = () => vi.fn<Canary>(async () => 1n);
/** A canary that throws: the RPC is down. */
const rpcDown = () =>
  vi.fn<Canary>(async () => {
    throw new Error("fetch failed");
  });

function answering(status: number, body: string) {
  const calls: { url: string; headers: Headers }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe("readLog", () => {
  it("reads Blockscout's hex numbers, an empty logIndex as 0, and drops the nulls it pads topics with", () => {
    expect(readLog(rawLog(TOKEN_A, SPENDER_X, 26))).toEqual({
      address: TOKEN_A,
      topics: [APPROVAL_TOPIC, topic(OWNER), topic(SPENDER_X)],
      blockNumber: 26,
      logIndex: 0,
      transactionHash: txHash(26, 0),
    });
    expect(readLog({ ...rawLog(TOKEN_A, SPENDER_X, 26), blockNumber: "26", logIndex: "3" })?.logIndex).toBe(3);
  });

  it("refuses a log with a missing or malformed field", () => {
    const good = rawLog(TOKEN_A, SPENDER_X, 26);
    const bad: unknown[] = [
      null,
      "x",
      { ...good, address: "nope" },
      { ...good, topics: "0x" },
      { ...good, topics: [APPROVAL_TOPIC, "0x12"] },
      { ...good, blockNumber: "twelve" },
      { ...good, transactionHash: 7 },
    ];
    for (const value of bad) expect(readLog(value)).toBeNull();
  });
});

describe("logsPageUrl", () => {
  it("asks the logs module for the owner's Approval events from a block on, with no key in the URL", () => {
    const url = new URL(logsPageUrl("https://api.blockscout.com/5042/api", OWNER, 77));
    expect(`${url.origin}${url.pathname}`).toBe("https://api.blockscout.com/5042/api");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      module: "logs",
      action: "getLogs",
      fromBlock: "77",
      toBlock: "latest",
      topic0: APPROVAL_TOPIC,
      topic1: topic(OWNER),
      topic0_1_opr: "and",
    });
  });

  it("filters on the Approval event's own topic", () => {
    expect(APPROVAL_TOPIC).toBe(toEventSelector("Approval(address,address,uint256)"));
  });
});

describe("readLogsPage", () => {
  it("sends the key as a bearer token, never in the URL, and returns the page's logs", async () => {
    const { calls, fetchFn } = answering(200, JSON.stringify({ status: "1", message: "OK", result: [rawLog(TOKEN_A, SPENDER_X, 5)] }));
    const url = logsPageUrl("https://api.blockscout.com/5042/api", OWNER, 0);
    expect(await readLogsPage(url, fetchFn, "proapi_k")).toHaveLength(1);
    expect(calls[0].url).toBe(url);
    expect(calls[0].url).not.toContain("proapi_k");
    expect(calls[0].headers.get("authorization")).toBe("Bearer proapi_k");
  });

  it("sends no authorization header without a key", async () => {
    const { calls, fetchFn } = answering(200, JSON.stringify({ status: "1", message: "OK", result: [] }));
    await readLogsPage("https://explorer.testnet.arc.io/api?module=logs", fetchFn);
    expect(calls[0].headers.has("authorization")).toBe(false);
  });

  it("reads 'No logs found' as an empty page", async () => {
    const { fetchFn } = answering(200, JSON.stringify({ status: "0", message: "No logs found", result: [] }));
    expect(await readLogsPage("https://x.test/api", fetchFn)).toEqual([]);
  });

  it("treats a refused key, a rate limit, a body that isn't JSON, or one without a list as an outage", async () => {
    const outages: [number, string][] = [
      [402, "Proceed with an API key"],
      [429, "{}"],
      [200, "<html>Just a moment...</html>"],
      [200, JSON.stringify({ status: "0", message: "Error! Invalid topic", result: null })],
    ];
    for (const [status, body] of outages) {
      await expect(readLogsPage("https://x.test/api", answering(status, body).fetchFn)).rejects.toBeInstanceOf(ApprovalsUnavailable);
    }
  });

  it(`bounds a page to ${LOGS_PAGE} logs, even when the explorer sends more`, async () => {
    const oversized = Array.from({ length: LOGS_PAGE + 1 }, (_, i) => rawLog(TOKEN_A, SPENDER_X, i + 1));
    const { fetchFn } = answering(200, JSON.stringify({ status: "1", message: "OK", result: oversized }));
    expect(await readLogsPage("https://x.test/api", fetchFn)).toHaveLength(LOGS_PAGE);
  });
});

describe("collectApprovalLogs", () => {
  it("reads a short page once", async () => {
    const readPage = vi.fn(async () => [rawLog(TOKEN_A, SPENDER_X, 5)]);
    const { logs, truncated } = await collectApprovalLogs(readPage);
    expect(readPage.mock.calls).toEqual([[0]]);
    expect(logs).toHaveLength(1);
    expect(truncated).toBe(false);
  });

  it("pages on from the last block a full page reached, and drops the logs it sees twice", async () => {
    const first = Array.from({ length: LOGS_PAGE }, (_, i) => rawLog(TOKEN_A, SPENDER_X, i + 1));
    const second = [rawLog(TOKEN_A, SPENDER_X, LOGS_PAGE), rawLog(TOKEN_B, SPENDER_Y, LOGS_PAGE + 1)];
    const readPage = vi.fn(async (from: number) => (from === 0 ? first : second));
    const { logs, truncated } = await collectApprovalLogs(readPage);
    expect(readPage.mock.calls.map(([from]) => from)).toEqual([0, LOGS_PAGE]);
    expect(logs).toHaveLength(LOGS_PAGE + 1);
    expect(truncated).toBe(false);
  });

  it(`stops after ${MAX_PAGES} full pages and says the list was cut`, async () => {
    const readPage = vi.fn(async (from: number) =>
      Array.from({ length: LOGS_PAGE }, (_, i) => rawLog(TOKEN_A, SPENDER_X, from + i + 1)),
    );
    const { truncated } = await collectApprovalLogs(readPage);
    expect(readPage).toHaveBeenCalledTimes(MAX_PAGES);
    expect(truncated).toBe(true);
  });

  it("stops, and says the list was cut, when one block holds a full page", async () => {
    const readPage = vi.fn(async () => Array.from({ length: LOGS_PAGE }, (_, i) => rawLog(TOKEN_A, SPENDER_X, 0, i)));
    const { truncated } = await collectApprovalLogs(readPage);
    expect(readPage).toHaveBeenCalledTimes(1);
    expect(truncated).toBe(true);
  });
});

describe("approvalPairs", () => {
  it("keeps ERC-20 approvals only: exactly three topics", () => {
    const erc721 = logOf(rawLog(TOKEN_B, SPENDER_Y, 11, 0, [pad("0x07", { size: 32 })]));
    expect(approvalPairs(OWNER, [logOf(rawLog(TOKEN_A, SPENDER_X, 10)), erc721])).toEqual([
      { token: TOKEN_A, spender: SPENDER_X, lastApprovalBlock: 10, lastApprovalLogIndex: 0 },
    ]);
  });

  it("keeps each token and spender once, with its latest approval's block, newest first", () => {
    const logs = [
      rawLog(TOKEN_A, SPENDER_X, 10),
      rawLog(TOKEN_A, SPENDER_X, 30, 1),
      rawLog(TOKEN_A, SPENDER_X, 20, 2),
      rawLog(TOKEN_B, SPENDER_Y, 15),
    ].map(logOf);
    expect(approvalPairs(OWNER, logs)).toEqual([
      { token: TOKEN_A, spender: SPENDER_X, lastApprovalBlock: 30, lastApprovalLogIndex: 1 },
      { token: TOKEN_B, spender: SPENDER_Y, lastApprovalBlock: 15, lastApprovalLogIndex: 0 },
    ]);
  });

  it("skips another event, another owner's approval, and a spender topic that isn't an address", () => {
    const transfer = { ...logOf(rawLog(TOKEN_A, SPENDER_X, 10)), topics: [TRANSFER_TOPIC, topic(OWNER), topic(SPENDER_X)] };
    const stranger = logOf(rawLog(TOKEN_A, SPENDER_X, 10, 0, [null], STRANGER));
    const junk = { ...logOf(rawLog(TOKEN_A, SPENDER_X, 10)), topics: [APPROVAL_TOPIC, topic(OWNER), `0x${"f".repeat(64)}` as Hex] };
    expect(approvalPairs(OWNER, [transfer, stranger, junk])).toEqual([]);
  });
});

describe("liveApprovals", () => {
  const pairs = [
    { token: TOKEN_A, spender: SPENDER_X, lastApprovalBlock: 30 },
    { token: TOKEN_A, spender: SPENDER_Y, lastApprovalBlock: 20 },
    { token: TOKEN_B, spender: SPENDER_X, lastApprovalBlock: 10 },
  ];

  it("reads every pair's allowance and each token's symbol, name and decimals in one multicall, dropping pairs at zero, and never asks the canary", async () => {
    const { aggregate, batches } = stubChain({
      allowance: (token, spender) =>
        token === TOKEN_A && spender === SPENDER_X ? 5n * 10n ** 18n : token === TOKEN_B ? UNLIMITED : 0n,
      symbol: (token) => str(token === TOKEN_A ? "AAA" : "BBB"),
      name: (token) => (token === TOKEN_A ? "Token A" : "Token B"),
      decimals: (token) => (token === TOKEN_A ? 18 : 6),
    });
    const canary = rpcUp();
    expect(await liveApprovals(OWNER, pairs, aggregate, canary, "mainnet")).toEqual({
      approvals: [
        {
          kind: "erc20",
          token: TOKEN_A,
          symbol: "AAA",
          name: "Token A",
          decimals: 18,
          spender: SPENDER_X,
          spenderLabel: null,
          allowance: (5n * 10n ** 18n).toString(),
          lastApprovalBlock: 30,
        },
        {
          kind: "erc20",
          token: TOKEN_B,
          symbol: "BBB",
          name: "Token B",
          decimals: 6,
          spender: SPENDER_X,
          spenderLabel: null,
          allowance: UNLIMITED.toString(),
          lastApprovalBlock: 10,
        },
      ],
      truncated: false,
    });
    expect(batches).toEqual([3 + 2 * 3]);
    expect(canary).not.toHaveBeenCalled();
  });

  it("cleans hostile labels, and reads a failed or odd answer as unknown", async () => {
    const { aggregate } = stubChain({
      allowance: () => 1n,
      // A bidi override and a zero-width space in one symbol; a bytes32 symbol (MKR's kind) in the other.
      symbol: (token) => (token === TOKEN_A ? str("A\u202EAA\u200B") : pad("0x4d4b52", { size: 32, dir: "right" })),
      name: (token) => (token === TOKEN_A ? "Token A" : "revert"),
      decimals: (token) => (token === TOKEN_A ? 18 : "revert"),
    });
    const { approvals } = await liveApprovals(OWNER, [pairs[0], pairs[2]], aggregate, rpcUp(), "mainnet");
    const [a, b] = approvals;
    expect(a.symbol).toBe("AAA");
    expect([b.symbol, b.name, b.decimals]).toEqual([null, null, null]);
  });

  it("drops a pair whose allowance can't be read: a revert inside an answered multicall, which the canary isn't asked about", async () => {
    const { aggregate } = stubChain({ allowance: (token) => (token === TOKEN_A ? "revert" : 1n) });
    const canary = rpcUp();
    const { approvals } = await liveApprovals(OWNER, pairs, aggregate, canary, "mainnet");
    expect(approvals.map((a) => a.token)).toEqual([TOKEN_B]);
    expect(canary).not.toHaveBeenCalled();
  });

  it("answers nothing without pairs, and never calls the chain", async () => {
    const aggregate = vi.fn<Aggregate>();
    const canary = rpcUp();
    expect(await liveApprovals(OWNER, [], aggregate, canary, "mainnet")).toEqual({ approvals: [], truncated: false });
    expect(aggregate).not.toHaveBeenCalled();
    expect(canary).not.toHaveBeenCalled();
  });

  it("never maps a multicall answer with the wrong number of results: that call failed, so the canary tells an outage from a truncated answer", async () => {
    const wrongCount = vi.fn<Aggregate>(async () => []);
    await expect(liveApprovals(OWNER, pairs, wrongCount, rpcDown(), "mainnet")).rejects.toBeInstanceOf(ApprovalsUnavailable);
    expect(await liveApprovals(OWNER, pairs, wrongCount, rpcUp(), "mainnet")).toEqual({ approvals: [], truncated: true });
  });

  it("splits the batch to isolate one poisoned token's calls: its pair is dropped, every other pair keeps its exact value, and the answer is marked truncated", async () => {
    // Every token gets its own metadata, so a wrong mapping after a split (review M-d) would fail this.
    const { aggregate: healthy } = stubChain({
      allowance: (token, spender) => (token === TOKEN_B && spender === SPENDER_X ? 9n : 0n),
      symbol: (token) => str(token === TOKEN_A ? "AAA" : "BBB"),
      name: (token) => (token === TOKEN_A ? "Token A" : "Token B"),
      decimals: (token) => (token === TOKEN_A ? 18 : 6),
    });
    const poisoned = vi.fn<Aggregate>(async (calls) => {
      // The poisoned token's fallback burns unbounded gas: any batch that touches it fails the whole eth_call, exactly
      // as it would running for real, whatever else shares the batch.
      if (calls.some((c) => c.target === TOKEN_A)) throw new Error("out of gas");
      return healthy(calls);
    });
    const canary = rpcUp();
    const { approvals, truncated } = await liveApprovals(OWNER, pairs, poisoned, canary, "mainnet");
    expect(approvals).toEqual([
      { kind: "erc20", token: TOKEN_B, symbol: "BBB", name: "Token B", decimals: 6, spender: SPENDER_X, spenderLabel: null, allowance: "9", lastApprovalBlock: 10 },
    ]);
    expect(truncated).toBe(true);
    expect(poisoned.mock.calls.length).toBeLessThanOrEqual(MULTICALL_BUDGET);
    expect(canary).toHaveBeenCalledTimes(1); // asked once, after the first call failed, and never again
  });

  it("rejects at once, so the route answers 503, when the first aggregate call fails and the canary fails too: the RPC is down (review N1 ruling)", async () => {
    const alwaysThrows = vi.fn<Aggregate>(async () => {
      throw new Error("fetch failed");
    });
    const canary = rpcDown();
    await expect(liveApprovals(OWNER, pairs, alwaysThrows, canary, "mainnet")).rejects.toBeInstanceOf(ApprovalsUnavailable);
    expect(alwaysThrows).toHaveBeenCalledTimes(1); // an outage is never split and retried
    expect(canary).toHaveBeenCalledTimes(1);
  });

  it("splits breadth-first, ordered token by token, so one poisoned token among 100 loses at most 4 of 200 pairs and nulls at most 8 tokens' metadata, within the call budget (review I-2)", async () => {
    const tokenAt = (i: number): Address => `0x${(0x1000 + i).toString(16).padStart(40, "0")}` as Address;
    const spenderAt = (i: number): Address => `0x${(0x9000 + i).toString(16).padStart(40, "0")}` as Address;
    const tokens100 = Array.from({ length: 100 }, (_, i) => tokenAt(i));
    const poisonedToken = tokens100[42]!;
    const pairs200 = tokens100.flatMap((token, i) => [
      { token, spender: spenderAt(i * 2), lastApprovalBlock: i * 2 + 1 },
      { token, spender: spenderAt(i * 2 + 1), lastApprovalBlock: i * 2 + 2 },
    ]);
    const { aggregate: healthy } = stubChain({ allowance: () => 1n });
    const poisoned = vi.fn<Aggregate>(async (calls) => {
      if (calls.some((c) => c.target === poisonedToken)) throw new Error("out of gas");
      return healthy(calls);
    });
    const { approvals, truncated } = await liveApprovals(OWNER, pairs200, poisoned, rpcUp(), "mainnet");
    const lostPairs = pairs200.length - approvals.length;
    const nulledTokens = new Set(approvals.filter((a) => a.symbol === null).map((a) => a.token));
    expect(lostPairs).toBeLessThanOrEqual(4);
    expect(nulledTokens.size).toBeLessThanOrEqual(8);
    expect(truncated).toBe(true);
    expect(poisoned.mock.calls.length).toBeLessThanOrEqual(MULTICALL_BUDGET);
  });

  it(`stops starting new attempts once ${MULTICALL_TIME_BUDGET_MS}ms have passed, marking what's left unresolved and truncated, with an injectable clock`, async () => {
    let elapsed = 0;
    const now = () => elapsed;
    const { aggregate: healthy } = stubChain({ allowance: (token) => (token === TOKEN_B ? 9n : 1n) });
    const slowPoison = vi.fn<Aggregate>(async (calls) => {
      elapsed += 3_000;
      if (calls.some((c) => c.target === TOKEN_A)) throw new Error("out of gas");
      return healthy(calls);
    });
    const { approvals, truncated } = await liveApprovals(OWNER, pairs, slowPoison, rpcUp(), "mainnet", now);
    expect(approvals.map((a) => a.token)).toEqual([TOKEN_B]);
    expect(truncated).toBe(true);
    expect(slowPoison.mock.calls.length).toBe(3);
  });

  it("rethrows an abort at once instead of treating it as a poisoned batch or asking the canary: not even one more attempt follows it", async () => {
    const abort = () => {
      throw new DOMException("This operation was aborted", "AbortError");
    };
    const aborted = vi.fn<Aggregate>(async () => abort());
    const canary = rpcUp();
    await expect(liveApprovals(OWNER, pairs, aborted, canary, "mainnet")).rejects.toMatchObject({ name: "AbortError" });
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(canary).not.toHaveBeenCalled();
  });

  it("groups by the lowercased token address, so a token's calls stay together (and share one row's worth of metadata) even spelled two ways (minor 5)", async () => {
    const TOKEN_MIXED = getAddress(`0x${"c".repeat(40)}`);
    expect(TOKEN_MIXED).not.toBe(TOKEN_MIXED.toLowerCase()); // otherwise this test proves nothing
    const pairsMixed = [
      { token: TOKEN_MIXED, spender: SPENDER_X, lastApprovalBlock: 40 },
      { token: TOKEN_B, spender: SPENDER_X, lastApprovalBlock: 30 },
      { token: TOKEN_A, spender: SPENDER_X, lastApprovalBlock: 20 }, // poisoned
      { token: TOKEN_MIXED.toLowerCase() as Address, spender: SPENDER_Y, lastApprovalBlock: 10 }, // same token, spelled lowercase
    ];
    const { aggregate: healthy } = stubChain({
      allowance: (token, spender) => {
        if (token.toLowerCase() === TOKEN_MIXED.toLowerCase()) return spender === SPENDER_X ? 4n : 7n;
        return token === TOKEN_B ? 9n : 0n;
      },
      symbol: (token) => str(token.toLowerCase() === TOKEN_MIXED.toLowerCase() ? "MIX" : "BBB"),
      name: () => "Token",
      decimals: () => 8,
    });
    const poisoned = vi.fn<Aggregate>(async (calls) => {
      if (calls.some((c) => c.target === TOKEN_A)) throw new Error("out of gas");
      return healthy(calls);
    });
    const { approvals, truncated } = await liveApprovals(OWNER, pairsMixed, poisoned, rpcUp(), "mainnet");
    expect(approvals).toEqual([
      { kind: "erc20", token: TOKEN_MIXED, symbol: "MIX", name: "Token", decimals: 8, spender: SPENDER_X, spenderLabel: null, allowance: "4", lastApprovalBlock: 40 },
      { kind: "erc20", token: TOKEN_B, symbol: "BBB", name: "Token", decimals: 8, spender: SPENDER_X, spenderLabel: null, allowance: "9", lastApprovalBlock: 30 },
      {
        kind: "erc20",
        token: TOKEN_MIXED.toLowerCase() as Address,
        symbol: "MIX",
        name: "Token",
        decimals: 8,
        spender: SPENDER_Y,
        spenderLabel: null,
        allowance: "7",
        lastApprovalBlock: 10,
      },
    ]);
    expect(truncated).toBe(true);
  });

  it("attempts the older tokens first, by each token's latest approval block, so a freshly spoofed token sits at the end and the older half goes first; the answer keeps its newest-first order (review N1 ruling)", async () => {
    const TOKEN_C: Address = "0x7777777777777777777777777777777777777777";
    const POISON: Address = "0x8888888888888888888888888888888888888888"; // freshly spoofed: the newest approval of all
    // Newest first, as approvalPairs hands them over. TOKEN_A goes by its latest approval (35), newer than TOKEN_C's
    // (30), even though its other one (10) is the oldest of all.
    const newestFirst = [
      { token: POISON, spender: SPENDER_X, lastApprovalBlock: 40 },
      { token: TOKEN_A, spender: SPENDER_Y, lastApprovalBlock: 35 },
      { token: TOKEN_C, spender: SPENDER_X, lastApprovalBlock: 30 },
      { token: TOKEN_B, spender: SPENDER_X, lastApprovalBlock: 20 },
      { token: TOKEN_A, spender: SPENDER_X, lastApprovalBlock: 10 },
    ];
    const labels: Record<string, string> = { [TOKEN_A]: "AAA", [TOKEN_B]: "BBB", [TOKEN_C]: "CCC" };
    const { aggregate: healthy } = stubChain({
      allowance: (token, spender) => (token === TOKEN_A ? (spender === SPENDER_X ? 3n : 4n) : token === TOKEN_B ? 5n : 6n),
      symbol: (token) => str(labels[token] ?? "???"),
    });
    const attempts: Address[][] = [];
    const aggregate = vi.fn<Aggregate>(async (calls) => {
      attempts.push([...new Set(calls.map((c) => c.target))]);
      if (calls.some((c) => c.target === POISON)) throw new Error("out of gas");
      return healthy(calls);
    });
    const { approvals, truncated } = await liveApprovals(OWNER, newestFirst, aggregate, rpcUp(), "mainnet");
    expect(attempts.slice(0, 3)).toEqual([
      [TOKEN_B, TOKEN_C, TOKEN_A, POISON], // oldest first, by latest block: 20, 30, 35, 40
      [TOKEN_B, TOKEN_C], // the older half, attempted first
      [TOKEN_A, POISON], // then the newer half, the spoofed token in it
    ]);
    expect(approvals.map((a) => [a.token, a.spender, a.symbol, a.allowance, a.lastApprovalBlock])).toEqual([
      [TOKEN_A, SPENDER_Y, "AAA", "4", 35],
      [TOKEN_C, SPENDER_X, "CCC", "6", 30],
      [TOKEN_B, SPENDER_X, "BBB", "5", 20],
      [TOKEN_A, SPENDER_X, "AAA", "3", 10],
    ]);
    expect(truncated).toBe(true);
  });
});

describe("spenderLabel", () => {
  it("names Permit2, Drop's Multisend and Circle's swap adapter on each network, and nothing else", () => {
    for (const network of ["mainnet", "testnet"] as const) {
      expect(spenderLabel(PERMIT2.toLowerCase(), network)).toBe("Permit2");
      expect(spenderLabel(ARCOS[network]!.multisend, network)).toBe("4rc.OS Multisend");
      expect(spenderLabel(SWAP_ADAPTER[network], network)).toBe("Circle swap adapter");
      expect(spenderLabel(SPENDER_X, network)).toBeNull();
    }
  });
});

describe("isUnlimited", () => {
  it("reads 2^255 and above as unlimited", () => {
    expect(isUnlimited(UNLIMITED - 1n)).toBe(false);
    expect(isUnlimited(UNLIMITED)).toBe(true);
    expect(isUnlimited(2n ** 256n - 1n)).toBe(true);
    expect(isUnlimited(0n)).toBe(false);
  });
});

describe("loadApprovals", () => {
  it("joins the pieces: the explorer's logs, their pairs, and what is still live", async () => {
    const { aggregate } = stubChain({ allowance: (token) => (token === TOKEN_A ? 7n : 0n) });
    const answer = await loadApprovals(OWNER, {
      network: "testnet",
      aggregate,
      canary: rpcUp(),
      readPage: async () => [rawLog(TOKEN_A, PERMIT2, 9), rawLog(TOKEN_B, SPENDER_Y, 8)],
    });
    expect(answer).toEqual({
      approvals: [
        expect.objectContaining({ token: TOKEN_A, spender: PERMIT2, spenderLabel: "Permit2", allowance: "7", lastApprovalBlock: 9 }),
      ],
      truncated: false,
    });
  });

  it(`checks at most ${MAX_PAIRS} pairs, the most recent, and says the list was cut`, async () => {
    const spender = (i: number) => `0x${(i + 0x1000).toString(16).padStart(40, "0")}` as Address;
    const logs = Array.from({ length: MAX_PAIRS + 1 }, (_, i) => rawLog(TOKEN_A, spender(i), i + 1));
    const { aggregate, batches } = stubChain({ allowance: () => 1n });
    const answer = await loadApprovals(OWNER, { network: "testnet", aggregate, canary: rpcUp(), readPage: async () => logs });
    expect(batches).toEqual([MAX_PAIRS + 3]);
    expect(answer.approvals).toHaveLength(MAX_PAIRS);
    expect(answer.approvals.at(-1)?.lastApprovalBlock).toBe(2);
    expect(answer.truncated).toBe(true);
  });

  // Fix round 3 (task-8-fix-3.md, ruling "one clock for the whole lookup"): loadApprovals now records the start
  // once, before the explorer phase, and passes it to both budgets below — so a slow explorer phase eats into the
  // multicall's own MULTICALL_TIME_BUDGET_MS, and both are measured against the same fake clock here.

  it(`finishes well before the route's 15 s deadline when a 3 s explorer phase is followed by one poisoned token among 200 pairs over 100 tokens: no aggregate call but the first starts ${MULTICALL_TIME_BUDGET_MS}ms or more after the lookup's start, at least 196 pairs are kept, and truncated is true (review N2)`, async () => {
    let elapsed = 0; // the lookup starts at 0 on this clock
    const now = () => elapsed;
    const starts: number[] = [];
    const tokenAt = (i: number): Address => `0x${(0x1000 + i).toString(16).padStart(40, "0")}` as Address;
    const spenderAt = (i: number): Address => `0x${(0x9000 + i).toString(16).padStart(40, "0")}` as Address;
    const tokens100 = Array.from({ length: 100 }, (_, i) => tokenAt(i));
    const poisonedToken = tokens100[42]!;
    const pairs200 = tokens100.flatMap((token, i) => [
      { token, spender: spenderAt(i * 2), lastApprovalBlock: i * 2 + 1 },
      { token, spender: spenderAt(i * 2 + 1), lastApprovalBlock: i * 2 + 2 },
    ]);
    const readPage = vi.fn(async () => {
      elapsed += 3_000; // the whole explorer phase: one page holds all 200 pairs' logs
      return pairs200.map((p, i) => rawLog(p.token, p.spender, i + 1));
    });
    const { aggregate: healthy } = stubChain({ allowance: () => 1n });
    const aggregate = vi.fn<Aggregate>(async (calls) => {
      starts.push(elapsed);
      // approvalPairs checksums every address (readLog's getAddress), so the poisoned token no longer spells the
      // way tokenAt(42) produced it by the time it reaches here: compare lowercased, as the real target does.
      const poisoned = calls.some((c) => c.target.toLowerCase() === poisonedToken.toLowerCase());
      elapsed += poisoned ? 650 : 200; // a poisoned attempt costs more than a healthy one, per the ruling's example
      if (poisoned) throw new Error("out of gas");
      return healthy(calls);
    });
    const canary = rpcUp();
    const answer = await loadApprovals(OWNER, { network: "testnet", readPage, aggregate, canary, now });
    expect(elapsed).toBeLessThan(15_000);
    expect(starts.length).toBeGreaterThan(1);
    // The cutoff counts from the lookup's start (0 here), not from the multicall's own start (3 s): every attempt
    // after the always-run first one started inside MULTICALL_TIME_BUDGET_MS of it.
    expect(starts.slice(1).filter((t) => t >= MULTICALL_TIME_BUDGET_MS)).toEqual([]);
    expect(answer.truncated).toBe(true);
    expect(answer.approvals.length).toBeGreaterThanOrEqual(196);
    expect(answer.approvals.some((a) => a.token.toLowerCase() === poisonedToken.toLowerCase())).toBe(false);
    expect(canary).toHaveBeenCalledTimes(1);
  });

  it(`stops paging once ${EXPLORER_TIME_BUDGET_MS}ms have passed (a third page, of 5 available, never starts), with truncated true and the multicall still running on the pages already read`, async () => {
    let elapsed = 0;
    const now = () => elapsed;
    let pagesRequested = 0;
    const readPage = vi.fn(async (from: number) => {
      pagesRequested += 1;
      // 3 s a page, not the 2.5 s the fix-3 brief named: at 2.5 s a third page would start at 5 s, still inside the
      // budget. At 3 s the second page ends exactly on the 6 s mark, so this also pins the cutoff's `>=`: with `>`,
      // a third page would start at 6 s.
      elapsed += 3_000;
      if (pagesRequested > 5) return [];
      return Array.from({ length: LOGS_PAGE }, (_, i) => rawLog(TOKEN_A, SPENDER_X, from + i + 1));
    });
    const { aggregate, batches } = stubChain({ allowance: () => 1n });
    const answer = await loadApprovals(OWNER, { network: "testnet", readPage, aggregate, canary: rpcUp(), now });
    expect(pagesRequested).toBe(2);
    expect(answer.truncated).toBe(true);
    expect(batches).toHaveLength(1); // the multicall still ran, once, on the one pair the pages already read named
  });

  it("still makes exactly one aggregate call, and no canary call, and returns the approvals when a clean lookup's explorer phase alone takes 9.5 s, past the multicall's own time budget", async () => {
    let elapsed = 0;
    const now = () => elapsed;
    const readPage = vi.fn(async () => {
      elapsed += 9_500;
      return [rawLog(TOKEN_A, SPENDER_X, 5)];
    });
    const { aggregate, batches } = stubChain({ allowance: () => 7n });
    const canary = rpcUp();
    const answer = await loadApprovals(OWNER, { network: "testnet", readPage, aggregate, canary, now });
    expect(batches).toEqual([1 + 3]);
    expect(canary).not.toHaveBeenCalled();
    expect(answer.approvals).toHaveLength(1);
    expect(answer.approvals[0]?.allowance).toBe("7");
    expect(answer.truncated).toBe(false);
  });

  it("answers in under 10 s of fake time when a 6 s explorer phase is followed by a poison at 650 ms an attempt: the multicall's cutoff counts from the lookup's start, not from its own (review N2, the round-2 scenario)", async () => {
    let elapsed = 0;
    const now = () => elapsed;
    const readPage = vi.fn(async () => {
      elapsed += 6_000;
      return [rawLog(TOKEN_A, SPENDER_X, 30), rawLog(TOKEN_A, SPENDER_Y, 20, 1), rawLog(TOKEN_B, SPENDER_X, 10)];
    });
    const { aggregate: healthy } = stubChain({ allowance: () => 1n });
    const aggregate = vi.fn<Aggregate>(async (calls) => {
      elapsed += 650; // every attempt, poisoned or not
      if (calls.some((c) => c.target === TOKEN_A)) throw new Error("out of gas");
      return healthy(calls);
    });
    const answer = await loadApprovals(OWNER, { network: "testnet", readPage, aggregate, canary: rpcUp(), now });
    // Counted from its own start (6 s), the cutoff would let the halving run on to about 13 s, past this bound; the
    // route's 15 s deadline would have little room left.
    expect(elapsed).toBeLessThan(10_000);
    expect(answer).toEqual({ approvals: [expect.objectContaining({ token: TOKEN_B, spender: SPENDER_X, allowance: "1" })], truncated: true });
  });

  it("answers an empty list marked truncated, never a rejection, when the owner's only pair is poisoned and the canary says the RPC is up (review N1)", async () => {
    const poisoned = vi.fn<Aggregate>(async () => {
      throw new Error("out of gas");
    });
    const canary = rpcUp();
    const answer = await loadApprovals(OWNER, {
      network: "testnet",
      readPage: async () => [rawLog(TOKEN_A, SPENDER_X, 9)],
      aggregate: poisoned,
      canary,
    });
    expect(answer).toEqual({ approvals: [], truncated: true });
    expect(canary).toHaveBeenCalledTimes(1);
    expect(poisoned.mock.calls.length).toBeLessThanOrEqual(MULTICALL_BUDGET);
  });

  it("resolves, never rejects, with truncated true before 15 s of fake time when 40 poisoned tokens sit ahead of 10 real ones in the call list (review N1)", async () => {
    let elapsed = 0;
    const now = () => elapsed;
    const tokenAt = (i: number): Address => `0x${(0x1000 + i).toString(16).padStart(40, "0")}` as Address;
    // Tokens 0-39 are poisoned, approved at blocks 1-40, older than the 10 real ones (41-50), so oldest-first puts
    // every one of them ahead: no healthy batch is reached inside either budget, and nothing is ever answered.
    const poisonedTokens = new Set(Array.from({ length: 40 }, (_, i) => tokenAt(i).toLowerCase()));
    const readPage = vi.fn(async () => {
      elapsed += 1_000;
      return Array.from({ length: 50 }, (_, i) => rawLog(tokenAt(i), SPENDER_X, i + 1));
    });
    const { aggregate: healthy } = stubChain({ allowance: () => 1n });
    const aggregate = vi.fn<Aggregate>(async (calls) => {
      const poisoned = calls.some((c) => poisonedTokens.has(c.target.toLowerCase()));
      elapsed += poisoned ? 650 : 200;
      if (poisoned) throw new Error("out of gas");
      return healthy(calls);
    });
    const canary = rpcUp();
    const answer = await loadApprovals(OWNER, { network: "testnet", readPage, aggregate, canary, now });
    expect(elapsed).toBeLessThan(15_000);
    expect(answer.truncated).toBe(true);
    expect(answer.approvals.some((a) => poisonedTokens.has(a.token.toLowerCase()))).toBe(false);
    expect(canary).toHaveBeenCalledTimes(1);
    expect(aggregate.mock.calls.length).toBeLessThanOrEqual(MULTICALL_BUDGET);
  });

  it("keeps time with performance.now() when no clock is given, so a wall clock stepping an hour ahead mid-lookup cuts no paging short", async () => {
    const wallClock = Date.now;
    let reads = 0;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => wallClock() + (reads++ > 0 ? 3_600_000 : 0));
    try {
      const readPage = vi.fn(async (from: number) =>
        from === 0
          ? Array.from({ length: LOGS_PAGE }, (_, i) => rawLog(TOKEN_A, SPENDER_X, i + 1))
          : [rawLog(TOKEN_B, SPENDER_Y, LOGS_PAGE + 1)],
      );
      const { aggregate } = stubChain({ allowance: () => 1n });
      const answer = await loadApprovals(OWNER, { network: "testnet", readPage, aggregate, canary: rpcUp() });
      expect(readPage).toHaveBeenCalledTimes(2);
      expect(answer.truncated).toBe(false);
    } finally {
      dateNow.mockRestore();
    }
  });
});

describe("approvalPairs within one block", () => {
  it("keeps each pair's latest log index, and lists pairs from the same block newest first by log index", () => {
    const logs = [rawLog(TOKEN_A, SPENDER_X, 10, 2), rawLog(TOKEN_B, SPENDER_Y, 10, 3), rawLog(TOKEN_A, SPENDER_X, 10, 1)].map(logOf);
    expect(approvalPairs(OWNER, logs)).toEqual([
      { token: TOKEN_B, spender: SPENDER_Y, lastApprovalBlock: 10, lastApprovalLogIndex: 3 },
      { token: TOKEN_A, spender: SPENDER_X, lastApprovalBlock: 10, lastApprovalLogIndex: 2 },
    ]);
  });
});
