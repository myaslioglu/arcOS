import { describe, expect, it } from "vitest";
import { BUDGET_SPENT, DEFAULT_EXPLORER_DAILY_BUDGET, NO_EXPLORER_KEY, budgetedFetch, dailyBudget, explorerDailyBudget } from "../explorer-budget";

describe("explorerDailyBudget", () => {
  it("is 300 calls a day per instance unless INSPECT_EXPLORER_DAILY_BUDGET says otherwise", () => {
    expect(DEFAULT_EXPLORER_DAILY_BUDGET).toBe(300);
    expect(explorerDailyBudget(undefined)).toBe(300);
    expect(explorerDailyBudget(" 1200 ")).toBe(1200);
    expect(explorerDailyBudget("0")).toBe(0);
  });

  it("ignores what isn't a whole number from 0 to 1,000,000", () => {
    for (const raw of ["", "-1", "1.5", "1e3", "abc", "1000001", "12345678", "+5"]) expect(explorerDailyBudget(raw), raw).toBe(300);
  });
});

describe("dailyBudget", () => {
  const at = (iso: string) => Date.parse(iso);

  it("counts calls against the limit, and never goes below nothing left", () => {
    let now = at("2026-11-27T10:00:00Z");
    const budget = dailyBudget(() => 3, () => now);
    expect(budget.remaining()).toBe(3);
    budget.spend();
    budget.spend();
    expect(budget.remaining()).toBe(1);
    budget.spend();
    budget.spend();
    expect(budget.remaining()).toBe(0);
    now = at("2026-11-27T23:59:59Z");
    expect(budget.remaining()).toBe(0);
  });

  it("starts again at UTC midnight", () => {
    let now = at("2026-11-27T23:59:00Z");
    const budget = dailyBudget(() => 2, () => now);
    budget.spend();
    budget.spend();
    expect(budget.remaining()).toBe(0);
    now = at("2026-11-28T00:00:00Z");
    expect(budget.remaining()).toBe(2);
  });

  it("counts the rest of the day as spent once told to, and reads a changed limit at once", () => {
    let limit = 10;
    const budget = dailyBudget(() => limit, () => at("2026-11-27T12:00:00Z"));
    budget.exhaust();
    expect(budget.remaining()).toBe(0);
    limit = 20;
    expect(budget.remaining()).toBe(10);
  });
});

describe("budgetedFetch", () => {
  const answering = (status: number) => (async () => new Response("{}", { status })) as typeof fetch;

  it("counts every request it sends", async () => {
    const budget = dailyBudget(() => 5, () => Date.parse("2026-11-27T12:00:00Z"));
    const fetchFn = budgetedFetch(budget, answering(200));
    await fetchFn("https://api.blockscout.test/a");
    await fetchFn("https://api.blockscout.test/b");
    expect(budget.remaining()).toBe(3);
  });

  it("spends the rest of the day on a 402, the PRO plan's quota or payment gone", async () => {
    const budget = dailyBudget(() => 5, () => Date.parse("2026-11-27T12:00:00Z"));
    const res = await budgetedFetch(budget, answering(402))("https://api.blockscout.test/a");
    expect(res.status).toBe(402);
    expect(budget.remaining()).toBe(0);
  });

  it("words why the explorer wasn't asked, in plain sentences", () => {
    expect(BUDGET_SPENT).toBe("The explorer wasn't asked: this server has used up today's explorer reads for chains other than Arc.");
    expect(NO_EXPLORER_KEY).toBe("The explorer wasn't asked: this server has no key for it.");
  });
});
