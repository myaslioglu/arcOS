import { describe, expect, it } from "vitest";
import { createPublicClient, custom, type EIP1193RequestFn } from "viem";
import { CHAINS } from "@arcos/chain";
import { ExplorerBudgetSpent, ExplorerRefused, REFUSAL_COOLDOWN_MS, budgetedFetch, liveInspector, spacedTurns, type Refusals } from "../inspect";
import type { ExplorerBudget } from "../run";

const budgetOf = (n: number): ExplorerBudget & { left: () => number } => {
  let left = n;
  return {
    left: () => left,
    remaining: () => left,
    spend: () => (left > 0 ? (left--, true) : false),
    exhaust: () => {
      left = 0;
    },
  };
};

/** A fetch that answers each URL with the status at the same index of `statuses` (200 past the end), recording the URLs sent. */
const answering = (statuses: number[]) => {
  const sent: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    sent.push(String(input));
    const status = statuses[sent.length - 1] ?? 200;
    return status === 200 ? Response.json({}) : new Response("{}", { status });
  }) as typeof fetch;
  return { sent, fetchFn };
};

describe("budgetedFetch", () => {
  it("spends one call per request, and refuses once the budget is spent, without sending", async () => {
    const { sent, fetchFn } = answering([]);
    const budget = budgetOf(2);
    const f = budgetedFetch(budget, fetchFn);
    await f("https://explorer.test/1");
    await f("https://explorer.test/2");
    await expect(f("https://explorer.test/3")).rejects.toBeInstanceOf(ExplorerBudgetSpent);
    expect(sent).toEqual(["https://explorer.test/1", "https://explorer.test/2"]);
    expect(budget.left()).toBe(0);
  });

  it("after a 429, sends nothing for the cooldown, then asks again; the budget is not spent meanwhile", async () => {
    let t = 1_000;
    const refusals: Refusals = { until: 0, now: () => t };
    const { sent, fetchFn } = answering([429]);
    const budget = budgetOf(10);
    const f = budgetedFetch(budget, fetchFn, refusals);
    expect((await f("https://explorer.test/1")).status).toBe(429);
    await expect(f("https://explorer.test/2")).rejects.toBeInstanceOf(ExplorerRefused);
    t += REFUSAL_COOLDOWN_MS - 1;
    await expect(f("https://explorer.test/3")).rejects.toBeInstanceOf(ExplorerRefused);
    t += 1;
    expect((await f("https://explorer.test/4")).status).toBe(200);
    expect(sent).toEqual(["https://explorer.test/1", "https://explorer.test/4"]);
    expect(budget.left()).toBe(8);
  });

  it("after a 402, spends the rest of the day's budget too: the plan's quota is the website's to keep", async () => {
    let t = 1_000;
    const refusals: Refusals = { until: 0, now: () => t };
    const { sent, fetchFn } = answering([402]);
    const budget = budgetOf(10);
    const f = budgetedFetch(budget, fetchFn, refusals);
    expect((await f("https://explorer.test/1")).status).toBe(402);
    expect(budget.left()).toBe(0);
    await expect(f("https://explorer.test/2")).rejects.toBeInstanceOf(ExplorerRefused);
    t += REFUSAL_COOLDOWN_MS;
    await expect(f("https://explorer.test/3")).rejects.toBeInstanceOf(ExplorerBudgetSpent);
    expect(sent).toEqual(["https://explorer.test/1"]);
  });

  it("passes any other answer through, 404 and 500 included, without a cooldown", async () => {
    const refusals: Refusals = { until: 0, now: () => 1_000 };
    const { sent, fetchFn } = answering([404, 500]);
    const f = budgetedFetch(budgetOf(10), fetchFn, refusals);
    expect((await f("https://explorer.test/1")).status).toBe(404);
    expect((await f("https://explorer.test/2")).status).toBe(500);
    expect((await f("https://explorer.test/3")).status).toBe(200);
    expect(sent).toHaveLength(3);
    expect(refusals.until).toBe(0);
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
