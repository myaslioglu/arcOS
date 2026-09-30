import { beforeEach, describe, expect, it, vi } from "vitest";
import { erc20Abi, type Address, type Hex } from "viem";
import { PERMIT2 } from "@arcos/chain";
import type { Approval } from "@/lib/approvals";

// The flow's one side effect outside the chain: counting a revoke. Mocked, so each test can see exactly when it counts.
const { trackEvent } = vi.hoisted(() => ({ trackEvent: vi.fn() }));
vi.mock("@/lib/analytics", () => ({ trackEvent }));

import { revokeStep, type RevokeClient, type RevokeDeps } from "../flow";
import { forgetRevokes, rowKey, stillLive } from "../rows";
import { liveRead, revokeSteps, revokeWrite } from "../tx";

/**
 * The revoke flow, driven end to end against a fake chain and a fake wallet: nothing here reaches a network, and
 * nothing is signed. Every test reads what the flow asked of each, in order.
 */

const OWNER: Address = "0x1111111111111111111111111111111111111111";
const TOKEN: Address = "0x3333333333333333333333333333333333333333";
const NFT: Address = "0x4444444444444444444444444444444444444444";
const SPENDER: Address = "0x5555555555555555555555555555555555555555";
const OTHER: Address = "0x6666666666666666666666666666666666666666";
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const CHAIN = 5042002;
const HASH: Hex = `0x${"ab".repeat(32)}`;

const row = (over: Partial<Approval> = {}): Approval => ({
  kind: "erc20",
  token: TOKEN,
  symbol: "AAA",
  name: "Token A",
  decimals: 18,
  spender: SPENDER,
  spenderLabel: null,
  allowance: "100",
  lastApprovalBlock: 10,
  ...over,
});
const nft = row({ kind: "erc721", token: NFT, tokenId: "7", allowance: "1", decimals: null });
const operator = row({ kind: "operator", token: NFT, allowance: "1", decimals: null });
const permit2 = (token: Address, spender: Address = SPENDER) => row({ kind: "permit2", token, spender, allowance: "5" });

type Log = [string, ...unknown[]];

/**
 * A fake chain: `before` answers each live read at the head, `after` at the receipt's block, keyed by the function
 * read; the wallet answers `send`. Every call lands in `log`.
 */
function fakeChain(opts: {
  head?: bigint;
  before: (fn: string, args: readonly unknown[]) => unknown;
  after?: (fn: string, args: readonly unknown[]) => unknown;
  receipt?: "success" | "reverted" | "lost";
  send?: () => Promise<Hex>;
  simulate?: () => Promise<never>;
  walletChainId?: number;
}) {
  const log: Log[] = [];
  const client: RevokeClient = {
    getBlockNumber: async (args) => {
      log.push(["getBlockNumber", args]);
      return opts.head ?? 100n;
    },
    readContract: async (args) => {
      log.push(["read", args.functionName, args.blockNumber]);
      return args.blockNumber === 500n ? (opts.after ?? opts.before)(args.functionName, args.args) : opts.before(args.functionName, args.args);
    },
    simulateContract: async (args) => {
      log.push(["simulate", args.functionName, args.args, args.account]);
      if (opts.simulate) return opts.simulate();
      return { request: { address: args.address, functionName: args.functionName, args: args.args } };
    },
    waitForTransactionReceipt: async ({ hash }) => {
      log.push(["receipt", hash]);
      if (opts.receipt === "lost") throw new Error("timed out");
      return { status: opts.receipt ?? "success", blockNumber: 500n };
    },
  };
  const writeContractAsync = vi.fn(async (request: object) => {
    log.push(["write", request]);
    return opts.send ? opts.send() : HASH;
  });
  const deps: RevokeDeps = {
    client,
    owner: OWNER,
    account: OWNER,
    chainId: CHAIN,
    walletChainId: opts.walletChainId ?? CHAIN,
    writeContractAsync,
  };
  return { deps, log, writeContractAsync };
}

beforeEach(() => {
  trackEvent.mockReset();
  forgetRevokes();
});

describe("tx: what each kind is revoked and read with", () => {
  it("revokes an ERC-20 allowance with approve(spender, 0)", () => {
    expect(revokeWrite([row()])).toMatchObject({ address: TOKEN, functionName: "approve", args: [SPENDER, 0n] });
    expect(liveRead(OWNER, row())).toMatchObject({ address: TOKEN, abi: erc20Abi, functionName: "allowance", args: [OWNER, SPENDER] });
  });

  it("revokes one NFT's approval with approve(0x0, id), and reads getApproved(id)", () => {
    expect(revokeWrite([nft])).toMatchObject({ address: NFT, functionName: "approve", args: [ZERO, 7n] });
    expect(liveRead(OWNER, nft)).toMatchObject({ address: NFT, functionName: "getApproved", args: [7n] });
  });

  it("revokes an operator with setApprovalForAll(operator, false), and reads isApprovedForAll", () => {
    expect(revokeWrite([operator])).toMatchObject({ address: NFT, functionName: "setApprovalForAll", args: [SPENDER, false] });
    expect(liveRead(OWNER, operator)).toMatchObject({ address: NFT, functionName: "isApprovedForAll", args: [OWNER, SPENDER] });
  });

  it("revokes Permit2 allowances with one lockdown naming every pair, and reads Permit2's allowance", () => {
    expect(revokeWrite([permit2(TOKEN), permit2(NFT, OTHER)])).toMatchObject({
      address: PERMIT2,
      functionName: "lockdown",
      args: [[{ token: TOKEN, spender: SPENDER }, { token: NFT, spender: OTHER }]],
    });
    expect(liveRead(OWNER, permit2(TOKEN))).toMatchObject({ address: PERMIT2, functionName: "allowance", args: [OWNER, TOKEN, SPENDER] });
  });

  it("refuses an NFT row without a usable id, rather than revoke NFT #0", () => {
    for (const tokenId of [undefined, "", " ", "0x7", "-1"]) {
      const bad = { ...nft, tokenId };
      expect(() => revokeWrite([bad]), String(tokenId)).toThrow();
      expect(() => liveRead(OWNER, bad), String(tokenId)).toThrow();
    }
  });

  it("refuses to put anything but Permit2 pairs in one transaction", () => {
    expect(() => revokeWrite([row(), nft])).toThrow();
    expect(() => revokeWrite([])).toThrow();
  });

  it("plans a bulk revoke as one transaction per row, in list order, then every Permit2 pair in one lockdown last", () => {
    const a = permit2(TOKEN);
    const b = permit2(NFT, OTHER);
    expect(revokeSteps([a, row(), b, nft, operator])).toEqual([[row()], [nft], [operator], [a, b]]);
    expect(revokeSteps([row()])).toEqual([[row()]]);
    expect(revokeSteps([])).toEqual([]);
  });
});

describe("revokeStep", () => {
  it("checks the chain, reads the head, reads the allowance at it, simulates, sends through the chain guard, waits, and reads again at the receipt's block", async () => {
    const { deps, log } = fakeChain({ before: () => 100n, after: () => 0n });
    const outcomes = await revokeStep([row()], deps);
    expect(outcomes).toEqual([{ key: rowKey(row()), result: "revoked", block: 500 }]);
    expect(log).toEqual([
      ["getBlockNumber", { cacheTime: 0 }],
      ["read", "allowance", 100n],
      ["simulate", "approve", [SPENDER, 0n], OWNER],
      ["write", { address: TOKEN, functionName: "approve", args: [SPENDER, 0n], chainId: CHAIN }],
      ["receipt", HASH],
      ["read", "allowance", 500n],
    ]);
    // The row stays hidden until a newer approval appears.
    expect(stillLive(OWNER, [row()])).toEqual([]);
    expect(stillLive(OWNER, [row({ lastApprovalBlock: 501 })])).toHaveLength(1);
  });

  it("counts a revoke once, only when it is confirmed and the approval reads cleared", async () => {
    await revokeStep([row()], fakeChain({ before: () => 100n, after: () => 0n }).deps);
    expect(trackEvent.mock.calls).toEqual([["revoke_success"]]);
  });

  it("asks nothing of the wallet when the wallet is on another network", async () => {
    const { deps, log } = fakeChain({ before: () => 100n, walletChainId: 1 });
    const outcomes = await revokeStep([row()], deps);
    expect(outcomes).toEqual([{ key: rowKey(row()), result: "failed", text: "Your wallet is on a different network. Switch to Arc and try again." }]);
    expect(log).toEqual([]);
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it("takes an approval already cleared as revoked, with no transaction, when the node has seen the approval", async () => {
    const { deps, log, writeContractAsync } = fakeChain({ head: 10n, before: () => 0n });
    const outcomes = await revokeStep([row()], deps);
    expect(outcomes).toEqual([{ key: rowKey(row()), result: "revoked", block: 10 }]);
    expect(log.map(([what]) => what)).toEqual(["getBlockNumber", "read"]);
    expect(writeContractAsync).not.toHaveBeenCalled();
    expect(trackEvent).not.toHaveBeenCalled(); // nothing was sent
  });

  it("doesn't believe a zero from a node behind the approval: it goes on to the wallet", async () => {
    const { deps, writeContractAsync } = fakeChain({ head: 9n, before: () => 0n });
    await revokeStep([row()], deps);
    expect(writeContractAsync).toHaveBeenCalledTimes(1);
  });

  it("says so when the revoke reverts, with the transaction's hash, and counts nothing", async () => {
    const { deps } = fakeChain({ before: () => 100n, receipt: "reverted" });
    expect(await revokeStep([row()], deps)).toEqual([
      { key: rowKey(row()), result: "failed", text: "The revoke reverted. The approval is unchanged.", hash: HASH },
    ]);
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it("never reads a sent revoke whose receipt didn't come back as nothing happened", async () => {
    const { deps } = fakeChain({ before: () => 100n, receipt: "lost" });
    expect(await revokeStep([row()], deps)).toEqual([
      { key: rowKey(row()), result: "failed", text: "The revoke was sent but isn't confirmed yet. Check the explorer before trying again.", hash: HASH },
    ]);
  });

  it("says the wallet has signed, with the hash, before it waits for the receipt, and never when the wallet refused", async () => {
    const { deps, log } = fakeChain({ before: () => 100n, after: () => 0n });
    const onSent = vi.fn((hash: Hex) => log.push(["sent", hash]));
    await revokeStep([row()], { ...deps, onSent });
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(log.map(([what]) => what)).toEqual(["getBlockNumber", "read", "simulate", "write", "sent", "receipt", "read"]);
    expect(log.find(([what]) => what === "sent")).toEqual(["sent", HASH]);

    const refused = fakeChain({
      before: () => 100n,
      send: async () => {
        throw Object.assign(new Error("User rejected the request."), { name: "UserRejectedRequestError" });
      },
    });
    const never = vi.fn();
    await revokeStep([row()], { ...refused.deps, onSent: never });
    expect(never).not.toHaveBeenCalled();
  });

  it("describes a wallet's refusal, with no hash, since nothing was sent", async () => {
    const { deps } = fakeChain({
      before: () => 100n,
      send: async () => {
        throw Object.assign(new Error("User rejected the request."), { name: "UserRejectedRequestError" });
      },
    });
    const [outcome] = await revokeStep([row()], deps);
    expect(outcome).toMatchObject({ result: "failed" });
    expect(outcome).not.toHaveProperty("hash");
  });

  it("reports an allowance still set after a confirmed revoke, and what is left", async () => {
    const { deps } = fakeChain({ before: () => 100n, after: () => 40n });
    expect(await revokeStep([row()], deps)).toEqual([{ key: rowKey(row()), result: "still-set", left: "40", hash: HASH }]);
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it("revokes an NFT's approval: cleared once getApproved reads the zero address", async () => {
    const { deps, log } = fakeChain({ before: () => SPENDER, after: () => ZERO });
    expect(await revokeStep([nft], deps)).toEqual([{ key: rowKey(nft), result: "revoked", block: 500 }]);
    expect(log.find(([what]) => what === "write")?.[1]).toMatchObject({ functionName: "approve", args: [ZERO, 7n], chainId: CHAIN });
  });

  it("revokes an operator: cleared once isApprovedForAll reads false", async () => {
    const { deps } = fakeChain({ before: () => true, after: () => false });
    expect(await revokeStep([operator], deps)).toEqual([{ key: rowKey(operator), result: "revoked", block: 500 }]);
  });

  it("locks down several Permit2 pairs in one transaction, leaving out one already at zero, and counts it once", async () => {
    const a = permit2(TOKEN);
    const b = permit2(NFT, OTHER);
    const { deps, log, writeContractAsync } = fakeChain({
      before: (_, args) => ((args as Address[])[1] === NFT ? [0n, 0, 0] : [5n, 99, 0]),
      after: () => [0n, 99, 1],
    });
    const outcomes = await revokeStep([a, b], deps);
    expect(outcomes).toEqual([
      { key: rowKey(b), result: "revoked", block: 10 },
      { key: rowKey(a), result: "revoked", block: 500 },
    ]);
    expect(writeContractAsync).toHaveBeenCalledTimes(1);
    expect(log.find(([what]) => what === "write")?.[1]).toMatchObject({
      address: PERMIT2,
      functionName: "lockdown",
      args: [[{ token: TOKEN, spender: SPENDER }]],
      chainId: CHAIN,
    });
    expect(trackEvent).toHaveBeenCalledTimes(1);
  });

  it("fails every row of a lockdown the wallet refused, and none silently", async () => {
    const a = permit2(TOKEN);
    const b = permit2(NFT, OTHER);
    const { deps } = fakeChain({
      before: () => [5n, 99, 0],
      simulate: async () => {
        throw new Error("execution reverted");
      },
    });
    const outcomes = await revokeStep([a, b], deps);
    expect(outcomes.map((o) => [o.key, o.result])).toEqual([
      [rowKey(a), "failed"],
      [rowKey(b), "failed"],
    ]);
  });
});
