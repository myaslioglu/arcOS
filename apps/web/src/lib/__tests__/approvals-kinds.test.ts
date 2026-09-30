import { describe, expect, it, vi } from "vitest";
import {
  decodeFunctionData,
  encodeAbiParameters,
  erc20Abi,
  multicall3Abi,
  pad,
  parseAbi,
  toEventSelector,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { PERMIT2, UNIVERSAL_ROUTERS } from "@arcos/chain";
import {
  APPROVAL_FOR_ALL_TOPIC,
  APPROVAL_TOPIC,
  EXPLORER_TIME_BUDGET_MS,
  LOGS_PAGE,
  MAX_PAIRS,
  OPERATOR_PAGES,
  PERMIT2_APPROVAL_TOPIC,
  PERMIT2_PAGES,
  PERMIT2_PERMIT_TOPIC,
  ApprovalsUnavailable,
  liveApprovals,
  loadApprovals,
  logsPageUrl,
  nftApprovalPairs,
  operatorPairs,
  permit2Pairs,
  readLog,
  spenderLabel,
  type Aggregate,
  type Canary,
} from "../approvals";

/**
 * Revoke's other three kinds of approval: one NFT's approval (ERC-721's four-topic Approval), an operator
 * (ApprovalForAll, ERC-721 and ERC-1155 alike) and a Permit2 allowance (Permit2's own Approval and Permit events).
 */

const OWNER: Address = "0x1111111111111111111111111111111111111111";
const STRANGER: Address = "0x2222222222222222222222222222222222222222";
const NFT: Address = "0x3333333333333333333333333333333333333333";
const TOKEN: Address = "0x4444444444444444444444444444444444444444";
const SPENDER_X: Address = "0x5555555555555555555555555555555555555555";
const SPENDER_Y: Address = "0x6666666666666666666666666666666666666666";
const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
const ZERO: Address = "0x0000000000000000000000000000000000000000";

const topic = (a: Address): Hex => pad(a.toLowerCase() as Hex, { size: 32 });
const idTopic = (id: bigint): Hex => pad(toHex(id), { size: 32 });

function raw(address: Address, topics: Hex[], block: number, index = 0) {
  return {
    address: address.toLowerCase(),
    topics: [...topics, ...Array(4 - topics.length).fill(null)],
    data: "0x",
    blockNumber: `0x${block.toString(16)}`,
    logIndex: index === 0 ? "0x" : `0x${index.toString(16)}`,
    transactionHash: `0x${(block * 1000 + index).toString(16).padStart(64, "0")}`,
    timeStamp: "0x0",
  };
}
const nftApproval = (approved: Address, id: bigint, block: number, from: Address = OWNER, index = 0) =>
  raw(NFT, [APPROVAL_TOPIC, topic(from), topic(approved), idTopic(id)], block, index);
const operatorLog = (collection: Address, operator: Address, block: number, from: Address = OWNER) =>
  raw(collection, [APPROVAL_FOR_ALL_TOPIC, topic(from), topic(operator)], block);
const permit2Log = (event: Hex, token: Address, spender: Address, block: number, from: Address = OWNER, at: Address = PERMIT2) =>
  raw(at, [event, topic(from), topic(token), topic(spender)], block);
const logs = (...raws: ReturnType<typeof raw>[]) => raws.map((r) => readLog(r)!);

const str = (s: string): Hex => encodeAbiParameters([{ type: "string" }], [s]);
const NFT_ABI = parseAbi([
  "function getApproved(uint256 tokenId) view returns (address)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
]);
const PERMIT2_ABI = parseAbi([
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
]);
const ALL = [...erc20Abi, ...NFT_ABI, ...multicall3Abi];

type Answers = {
  getApproved?: (target: Address, id: bigint) => Address | "revert";
  ownerOf?: (target: Address, id: bigint) => Address | "revert";
  isApprovedForAll?: (target: Address, operator: Address) => boolean | "revert";
  permit2?: (token: Address, spender: Address) => { amount: bigint; expiration: number } | "revert";
  timestamp?: bigint | "revert";
  allowance?: (target: Address, spender: Address) => bigint;
};

/** A stub Multicall3 that answers every read Revoke makes, from `answers`; "revert" fails that one call. */
function stubChain(answers: Answers) {
  const seen: { target: Address; functionName: string }[][] = [];
  const aggregate: Aggregate = async (calls) => {
    const batch: { target: Address; functionName: string }[] = [];
    seen.push(batch);
    return calls.map(({ target, callData }) => {
      const ok = (returnData: Hex) => ({ success: true, returnData });
      const fail = { success: false, returnData: "0x" as Hex };
      if (target === PERMIT2) {
        const { args } = decodeFunctionData({ abi: PERMIT2_ABI, data: callData });
        batch.push({ target, functionName: "permit2.allowance" });
        const a = answers.permit2?.(args[1], args[2]) ?? "revert";
        if (a === "revert") return fail;
        return ok(encodeAbiParameters([{ type: "uint160" }, { type: "uint48" }, { type: "uint48" }], [a.amount, a.expiration, 0]));
      }
      const { functionName, args } = decodeFunctionData({ abi: ALL, data: callData });
      batch.push({ target, functionName });
      const a = args as readonly unknown[];
      switch (functionName) {
        case "getCurrentBlockTimestamp": {
          const t = answers.timestamp ?? "revert";
          return t === "revert" ? fail : ok(encodeAbiParameters([{ type: "uint256" }], [t]));
        }
        case "getApproved": {
          const v = answers.getApproved?.(target, a[0] as bigint) ?? "revert";
          return v === "revert" ? fail : ok(encodeAbiParameters([{ type: "address" }], [v]));
        }
        case "ownerOf": {
          const v = answers.ownerOf?.(target, a[0] as bigint) ?? "revert";
          return v === "revert" ? fail : ok(encodeAbiParameters([{ type: "address" }], [v]));
        }
        case "isApprovedForAll": {
          const v = answers.isApprovedForAll?.(target, a[1] as Address) ?? "revert";
          return v === "revert" ? fail : ok(encodeAbiParameters([{ type: "bool" }], [v]));
        }
        case "allowance":
          return ok(encodeAbiParameters([{ type: "uint256" }], [answers.allowance?.(target, a[1] as Address) ?? 0n]));
        case "symbol":
          return ok(str(target === NFT ? "PUNK" : "TKN"));
        case "name":
          return ok(str(target === NFT ? "Punks" : "Token"));
        case "decimals":
          return target === NFT ? fail : ok(encodeAbiParameters([{ type: "uint8" }], [6]));
        default:
          return fail;
      }
    });
  };
  return { aggregate, seen };
}

const rpcUp = () => vi.fn<Canary>(async () => 1n);

describe("event topics", () => {
  it("are the events' own selectors", () => {
    expect(APPROVAL_FOR_ALL_TOPIC).toBe(toEventSelector("ApprovalForAll(address,address,bool)"));
    expect(PERMIT2_APPROVAL_TOPIC).toBe(toEventSelector("Approval(address,address,address,uint160,uint48)"));
    expect(PERMIT2_PERMIT_TOPIC).toBe(toEventSelector("Permit(address,address,address,uint160,uint48,uint48)"));
  });
});

describe("logsPageUrl for the other two scans", () => {
  it("asks for the owner's ApprovalForAll events", () => {
    const url = new URL(logsPageUrl("https://api.blockscout.com/5042/api", OWNER, 9, "operator"));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      module: "logs",
      action: "getLogs",
      fromBlock: "9",
      toBlock: "latest",
      topic0: APPROVAL_FOR_ALL_TOPIC,
      topic1: topic(OWNER),
      topic0_1_opr: "and",
    });
  });

  it("asks Permit2 for every event naming the owner first, so one request brings both Approval and Permit", () => {
    const url = new URL(logsPageUrl("https://api.blockscout.com/5042/api", OWNER, 0, "permit2"));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      module: "logs",
      action: "getLogs",
      fromBlock: "0",
      toBlock: "latest",
      address: PERMIT2,
      topic1: topic(OWNER),
    });
  });

  it("keeps the Approval scan's URL as it was", () => {
    const url = new URL(logsPageUrl("https://x.test/api", OWNER, 0));
    expect(url.searchParams.get("topic0")).toBe(APPROVAL_TOPIC);
    expect(url.searchParams.has("address")).toBe(false);
  });
});

describe("nftApprovalPairs", () => {
  it("keeps four-topic Approvals only, one per NFT, from its latest event, newest first", () => {
    const found = nftApprovalPairs(
      OWNER,
      logs(
        nftApproval(SPENDER_X, 7n, 10),
        nftApproval(SPENDER_Y, 7n, 12),
        nftApproval(SPENDER_X, 8n, 11),
        raw(TOKEN, [APPROVAL_TOPIC, topic(OWNER), topic(SPENDER_X)], 13), // ERC-20: three topics
      ),
    );
    expect(found).toEqual([
      { kind: "erc721", token: NFT, spender: SPENDER_Y, tokenId: 7n, lastApprovalBlock: 12 },
      { kind: "erc721", token: NFT, spender: SPENDER_X, tokenId: 8n, lastApprovalBlock: 11 },
    ]);
  });

  it("drops an NFT whose latest Approval cleared it, another owner's, and a topic that isn't an address", () => {
    const junk = { ...readLog(nftApproval(SPENDER_X, 9n, 5))!, topics: [APPROVAL_TOPIC, topic(OWNER), `0x${"f".repeat(64)}` as Hex, idTopic(9n)] };
    expect(
      nftApprovalPairs(OWNER, [
        ...logs(nftApproval(SPENDER_X, 7n, 10), nftApproval(ZERO, 7n, 11), nftApproval(SPENDER_X, 8n, 12, STRANGER)),
        junk,
      ]),
    ).toEqual([]);
  });
});

describe("operatorPairs", () => {
  it("keeps each collection and operator once, newest first, for this owner only", () => {
    const found = operatorPairs(
      OWNER,
      logs(operatorLog(NFT, SPENDER_X, 10), operatorLog(NFT, SPENDER_X, 14), operatorLog(TOKEN, SPENDER_Y, 12), operatorLog(NFT, SPENDER_Y, 15, STRANGER)),
    );
    expect(found).toEqual([
      { kind: "operator", token: NFT, spender: SPENDER_X, lastApprovalBlock: 14 },
      { kind: "operator", token: TOKEN, spender: SPENDER_Y, lastApprovalBlock: 12 },
    ]);
  });

  it("ignores any other event, such as an Approval an explorer sent back", () => {
    expect(operatorPairs(OWNER, logs(nftApproval(SPENDER_X, 1n, 3), raw(TOKEN, [APPROVAL_TOPIC, topic(OWNER), topic(SPENDER_X)], 4)))).toEqual([]);
  });
});

describe("permit2Pairs", () => {
  it("reads Permit2's Approval and Permit events, token and spender from their topics, each pair once, newest first", () => {
    const found = permit2Pairs(
      OWNER,
      logs(
        permit2Log(PERMIT2_APPROVAL_TOPIC, TOKEN, SPENDER_X, 10),
        permit2Log(PERMIT2_PERMIT_TOPIC, TOKEN, SPENDER_X, 20),
        permit2Log(PERMIT2_PERMIT_TOPIC, NFT, SPENDER_Y, 15),
      ),
    );
    expect(found).toEqual([
      { kind: "permit2", token: TOKEN, spender: SPENDER_X, lastApprovalBlock: 20 },
      { kind: "permit2", token: NFT, spender: SPENDER_Y, lastApprovalBlock: 15 },
    ]);
  });

  it("trusts only Permit2's own logs: the same event from another contract, another owner's, or Permit2's other events don't count", () => {
    const lockdown = toEventSelector("Lockdown(address,address,address)");
    expect(
      permit2Pairs(
        OWNER,
        logs(
          permit2Log(PERMIT2_PERMIT_TOPIC, TOKEN, SPENDER_X, 10, OWNER, STRANGER),
          permit2Log(PERMIT2_PERMIT_TOPIC, TOKEN, SPENDER_X, 11, STRANGER),
          raw(PERMIT2, [lockdown, topic(OWNER)], 12),
        ),
      ),
    ).toEqual([]);
  });
});

describe("spenderLabel", () => {
  it("names both Universal Routers", () => {
    for (const router of UNIVERSAL_ROUTERS.mainnet) expect(spenderLabel(router, "mainnet")).toBe("Uniswap Universal Router");
    expect(spenderLabel(UNIVERSAL_ROUTERS.mainnet[0]!.toLowerCase(), "testnet")).toBe("Uniswap Universal Router");
    expect(spenderLabel(UNIVERSAL_ROUTERS.mainnet[1]!, "testnet")).toBeNull();
  });
});

describe("liveApprovals for NFTs, operators and Permit2", () => {
  it("keeps an NFT approval while the owner still holds it and it is still approved, naming whoever is approved now", async () => {
    const { aggregate } = stubChain({
      getApproved: (_, id) => (id === 7n ? SPENDER_Y : id === 8n ? ZERO : SPENDER_X),
      ownerOf: (_, id) => (id === 9n ? STRANGER : OWNER),
    });
    const candidates = [7n, 8n, 9n].map((tokenId, i) => ({ kind: "erc721" as const, token: NFT, spender: SPENDER_X, tokenId, lastApprovalBlock: 10 + i }));
    const { approvals, truncated } = await liveApprovals(OWNER, candidates, aggregate, rpcUp(), "mainnet");
    expect(truncated).toBe(false);
    expect(approvals).toEqual([
      {
        kind: "erc721",
        token: NFT,
        symbol: "PUNK",
        name: "Punks",
        decimals: null,
        spender: SPENDER_Y,
        spenderLabel: null,
        allowance: "1",
        tokenId: "7",
        lastApprovalBlock: 10,
      },
    ]);
  });

  it("keeps an operator only while isApprovedForAll reads true", async () => {
    const { aggregate } = stubChain({ isApprovedForAll: (target) => target === NFT });
    const { approvals } = await liveApprovals(
      OWNER,
      [
        { kind: "operator", token: NFT, spender: SPENDER_X, lastApprovalBlock: 5 },
        { kind: "operator", token: TOKEN, spender: SPENDER_X, lastApprovalBlock: 4 },
      ],
      aggregate,
      rpcUp(),
      "mainnet",
    );
    expect(approvals).toEqual([expect.objectContaining({ kind: "operator", token: NFT, spender: SPENDER_X, allowance: "1" })]);
    expect(approvals[0]).not.toHaveProperty("tokenId");
  });

  it("reads a Permit2 allowance from Permit2, dropping one at zero and one expired by the chain's own clock", async () => {
    const { aggregate, seen } = stubChain({
      timestamp: 1_000n,
      permit2: (_, spender) => (spender === SPENDER_X ? { amount: 50n, expiration: 1_000 } : { amount: 50n, expiration: 999 }),
    });
    const { approvals } = await liveApprovals(
      OWNER,
      [
        { kind: "permit2", token: TOKEN, spender: SPENDER_X, lastApprovalBlock: 9 },
        { kind: "permit2", token: TOKEN, spender: SPENDER_Y, lastApprovalBlock: 8 },
      ],
      aggregate,
      rpcUp(),
      "mainnet",
      undefined,
      undefined,
      MULTICALL3,
    );
    expect(approvals).toEqual([
      {
        kind: "permit2",
        token: TOKEN,
        symbol: "TKN",
        name: "Token",
        decimals: 6,
        spender: SPENDER_X,
        spenderLabel: null,
        allowance: "50",
        expiration: 1_000,
        lastApprovalBlock: 9,
      },
    ]);
    // One multicall: the chain's clock once, and Permit2's allowance for each pair, next to the token's metadata.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.filter((c) => c.functionName === "getCurrentBlockTimestamp")).toEqual([{ target: MULTICALL3, functionName: "getCurrentBlockTimestamp" }]);
    expect(seen[0]!.filter((c) => c.functionName === "permit2.allowance")).toHaveLength(2);
  });

  it("keeps a Permit2 allowance whose expiry can't be judged, rather than hide a live one, when the clock can't be read", async () => {
    const { aggregate } = stubChain({ timestamp: "revert", permit2: () => ({ amount: 5n, expiration: 1 }) });
    const { approvals } = await liveApprovals(
      OWNER,
      [{ kind: "permit2", token: TOKEN, spender: SPENDER_X, lastApprovalBlock: 9 }],
      aggregate,
      rpcUp(),
      "mainnet",
      undefined,
      undefined,
      MULTICALL3,
    );
    expect(approvals).toEqual([expect.objectContaining({ kind: "permit2", allowance: "5", expiration: 1 })]);
  });

  it("drops what can't be read: an NFT whose ownerOf reverts, an operator whose check reverts, a Permit2 read that fails", async () => {
    const { aggregate } = stubChain({ getApproved: () => SPENDER_X, ownerOf: () => "revert", isApprovedForAll: () => "revert", permit2: () => "revert" });
    const { approvals, truncated } = await liveApprovals(
      OWNER,
      [
        { kind: "erc721", token: NFT, spender: SPENDER_X, tokenId: 1n, lastApprovalBlock: 3 },
        { kind: "operator", token: NFT, spender: SPENDER_X, lastApprovalBlock: 2 },
        { kind: "permit2", token: TOKEN, spender: SPENDER_X, lastApprovalBlock: 1 },
      ],
      aggregate,
      rpcUp(),
      "mainnet",
    );
    expect(approvals).toEqual([]);
    expect(truncated).toBe(false);
  });

  it("marks ERC-20 rows with their kind", async () => {
    const { aggregate } = stubChain({ allowance: () => 3n });
    const { approvals } = await liveApprovals(OWNER, [{ token: TOKEN, spender: SPENDER_X, lastApprovalBlock: 1 }], aggregate, rpcUp(), "mainnet");
    expect(approvals).toEqual([expect.objectContaining({ kind: "erc20", allowance: "3" })]);
    expect(approvals[0]).not.toHaveProperty("tokenId");
    expect(approvals[0]).not.toHaveProperty("expiration");
  });
});

describe("loadApprovals with all three scans", () => {
  const page = (items: unknown[]) => vi.fn(async () => items);

  it("reads the Approval scan, then ApprovalForAll, then Permit2, one request each when every page is short, and joins them newest first", async () => {
    const order: string[] = [];
    const readPage = vi.fn(async () => (order.push("approval"), [nftApproval(SPENDER_X, 7n, 30), raw(TOKEN, [APPROVAL_TOPIC, topic(OWNER), topic(SPENDER_X)], 10)]));
    const readOperatorPage = vi.fn(async () => (order.push("operator"), [operatorLog(NFT, SPENDER_Y, 20)]));
    const readPermit2Page = vi.fn(async () => (order.push("permit2"), [permit2Log(PERMIT2_PERMIT_TOPIC, TOKEN, SPENDER_Y, 40)]));
    const { aggregate } = stubChain({
      allowance: () => 1n,
      getApproved: () => SPENDER_X,
      ownerOf: () => OWNER,
      isApprovedForAll: () => true,
      timestamp: 5n,
      permit2: () => ({ amount: 9n, expiration: 10 }),
    });
    const answer = await loadApprovals(OWNER, {
      network: "mainnet",
      readPage,
      readOperatorPage,
      readPermit2Page,
      aggregate,
      canary: rpcUp(),
      clock: MULTICALL3,
    });
    expect(order).toEqual(["approval", "operator", "permit2"]);
    expect(answer.truncated).toBe(false);
    expect(answer.approvals.map((a) => [a.kind, a.lastApprovalBlock])).toEqual([
      ["permit2", 40],
      ["erc721", 30],
      ["operator", 20],
      ["erc20", 10],
    ]);
  });

  it(`reads at most ${OPERATOR_PAGES} ApprovalForAll pages and ${PERMIT2_PAGES} Permit2 pages, and says the list was cut`, async () => {
    const full = (make: (i: number) => ReturnType<typeof raw>) => vi.fn(async (from: number) => Array.from({ length: LOGS_PAGE }, (_, i) => make(from + i + 1)));
    const readOperatorPage = full((b) => operatorLog(NFT, `0x${b.toString(16).padStart(40, "0")}` as Address, b));
    const readPermit2Page = full((b) => permit2Log(PERMIT2_PERMIT_TOPIC, TOKEN, `0x${b.toString(16).padStart(40, "0")}` as Address, b));
    const { aggregate } = stubChain({ isApprovedForAll: () => true, permit2: () => ({ amount: 1n, expiration: 9 }) });
    const answer = await loadApprovals(OWNER, { network: "mainnet", readPage: page([]), readOperatorPage, readPermit2Page, aggregate, canary: rpcUp() });
    expect(readOperatorPage).toHaveBeenCalledTimes(OPERATOR_PAGES);
    expect(readPermit2Page).toHaveBeenCalledTimes(PERMIT2_PAGES);
    expect(answer.truncated).toBe(true);
    expect(answer.approvals.length).toBeLessThanOrEqual(MAX_PAIRS);
  });

  it("starts no ApprovalForAll or Permit2 request once the explorer's time budget is spent, and says the list was cut", async () => {
    let elapsed = 0;
    const readPage = vi.fn(async () => {
      elapsed += EXPLORER_TIME_BUDGET_MS;
      return [];
    });
    const readOperatorPage = page([]);
    const readPermit2Page = page([]);
    const { aggregate } = stubChain({});
    const answer = await loadApprovals(OWNER, { network: "mainnet", readPage, readOperatorPage, readPermit2Page, aggregate, canary: rpcUp(), now: () => elapsed });
    expect(readOperatorPage).not.toHaveBeenCalled();
    expect(readPermit2Page).not.toHaveBeenCalled();
    expect(answer).toEqual({ approvals: [], truncated: true });
  });

  it("keeps the token list when a later scan fails, and says it may be incomplete; a failed first scan still fails the lookup", async () => {
    const { aggregate } = stubChain({ allowance: () => 2n });
    const failing = vi.fn(async (): Promise<unknown[]> => {
      throw new ApprovalsUnavailable("The explorer answered 500.");
    });
    const answer = await loadApprovals(OWNER, {
      network: "mainnet",
      readPage: page([raw(TOKEN, [APPROVAL_TOPIC, topic(OWNER), topic(SPENDER_X)], 10)]),
      readOperatorPage: failing,
      readPermit2Page: page([]),
      aggregate,
      canary: rpcUp(),
    });
    expect(answer.truncated).toBe(true);
    expect(answer.approvals).toEqual([expect.objectContaining({ kind: "erc20", allowance: "2" })]);
    await expect(loadApprovals(OWNER, { network: "mainnet", readPage: failing, aggregate, canary: rpcUp() })).rejects.toBeInstanceOf(ApprovalsUnavailable);
  });

  it("lets an abort through from a later scan, instead of reading it as a partial answer", async () => {
    const aborted = vi.fn(async (): Promise<unknown[]> => {
      throw new DOMException("aborted", "AbortError");
    });
    const { aggregate } = stubChain({});
    await expect(
      loadApprovals(OWNER, { network: "mainnet", readPage: page([]), readOperatorPage: aborted, aggregate, canary: rpcUp() }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
