import { describe, expect, it } from "vitest";
import { createPublicClient, custom, type EIP1193RequestFn } from "viem";
import { CHAINS } from "@arcos/chain";
import { ExplorerBudgetSpent, budgetedFetch, liveInspector, spacedTurns } from "../inspect";
import type { ExplorerBudget } from "../run";

const budgetOf = (n: number): ExplorerBudget & { left: () => number } => {
  let left = n;
  return { left: () => left, remaining: () => left, spend: () => (left > 0 ? (left--, true) : false) };
};

describe("budgetedFetch", () => {
  it("spends one call per request, and refuses once the budget is spent, without sending", async () => {
    const sent: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => {
      sent.push(String(input));
      return Response.json({});
    }) as typeof fetch;
    const budget = budgetOf(2);
    const f = budgetedFetch(budget, fetchFn);
    await f("https://explorer.test/1");
    await f("https://explorer.test/2");
    await expect(f("https://explorer.test/3")).rejects.toBeInstanceOf(ExplorerBudgetSpent);
    expect(sent).toEqual(["https://explorer.test/1", "https://explorer.test/2"]);
    expect(budget.left()).toBe(0);
  });
});

describe("spacedTurns", () => {
  it("lets one request start every 250 ms, in order", async () => {
    let t = 0;
    const slept: number[] = [];
    const turn = spacedTurns(250, () => t, async (ms) => {
      slept.push(ms);
      t += ms;
    });
    await Promise.all([turn(), turn(), turn()]);
    expect(slept).toEqual([250, 250]);
  });
});

describe("liveInspector", () => {
  /** A node with no code anywhere: every inspection ends at once with NotAContract. */
  const empty = createPublicClient({
    chain: CHAINS.mainnet,
    transport: custom({ request: (async ({ method }: { method: string }) => (method === "eth_getCode" ? "0x" : "0x0")) as unknown as EIP1193RequestFn }),
  });

  it("runs the Inspector on the indexer's own client, and asks the explorer nothing without a key or a budget", async () => {
    const asked: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return Response.json({});
    }) as typeof fetch;
    const inspectToken = liveInspector({ network: "mainnet", client: empty, fetchFn });
    await expect(inspectToken("0x470f09ae20163d5e243f6530fb328912a8fcb099", [], budgetOf(5))).rejects.toMatchObject({ name: "NotAContract" });
    const keyed = liveInspector({ network: "mainnet", apiKey: "k", client: empty, fetchFn });
    await expect(keyed("0x470f09ae20163d5e243f6530fb328912a8fcb099", [], null)).rejects.toMatchObject({ name: "NotAContract" });
    expect(asked).toEqual([]);
  });
});
