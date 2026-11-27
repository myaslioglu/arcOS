/**
 * A daily soft budget of explorer calls for the Inspector on chains other than Arc, kept per server instance (in memory,
 * one per process: see inspect-server.ts). The server reads Blockscout's PRO API with one key for every chain, and the
 * plan's quota is shared with the indexer and with Revoke (docs/OPERATIONS.md, "The indexer"): on 2026-10-02 the
 * indexer alone spent all of it, and every Revoke lookup on the site failed until the UTC day ended. So inspections off
 * Arc get a share of their own, and past it they are read without the explorer: the explorer-based checks (source
 * verification, holder concentration) say so and read unknown, and everything else runs as usual.
 *
 * Soft: whether there is budget left is asked when an inspection starts, and every request it then sends is counted.
 * Inspections already running can take the count past the budget by what they still send (at most the 8 that run at
 * once, about 6 requests each). Pure: no "server-only", so its timing can be unit-tested.
 */

/**
 * The default: 300 explorer calls per instance per UTC day, 50 to 75 inspections off Arc (each sends 4 to 6). App
 * Hosting runs at most 2 instances (apps/web/apphosting.yaml), so 600 a day at most: under a third of the 2,000 the
 * plan's 5,000 leaves the site after the indexer's 3,000, for Revoke and for Arc's own server-built pages.
 */
export const DEFAULT_EXPLORER_DAILY_BUDGET = 300;

/**
 * The budget from `INSPECT_EXPLORER_DAILY_BUDGET` (a plain, non-secret runtime setting), or the default: a whole number
 * from 0 to 1,000,000, as the indexer reads its own. 0 means never ask the explorer off Arc. Anything else is ignored.
 */
export function explorerDailyBudget(raw: string | undefined = process.env.INSPECT_EXPLORER_DAILY_BUDGET): number {
  const text = raw?.trim();
  const value = text && /^\d{1,7}$/.test(text) ? Number(text) : NaN;
  return Number.isSafeInteger(value) && value <= 1_000_000 ? value : DEFAULT_EXPLORER_DAILY_BUDGET;
}

export type DailyBudget = {
  /** Calls left today (UTC), never below 0. */
  remaining(): number;
  /** Counts one call. */
  spend(): void;
  /** Counts the rest of the day as spent: the explorer said the plan's quota or its payment is gone (a 402). */
  exhaust(): void;
};

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A budget of `limit()` calls a UTC day, read each time it is asked, so a changed setting counts from the next call. */
export function dailyBudget(limit: () => number = () => explorerDailyBudget(), now: () => number = Date.now): DailyBudget {
  let day = utcDay(now());
  let spent = 0;
  const today = () => {
    const d = utcDay(now());
    if (d !== day) {
      day = d;
      spent = 0;
    }
  };
  return {
    remaining: () => {
      today();
      return Math.max(0, limit() - spent);
    },
    spend: () => {
      today();
      spent++;
    },
    exhaust: () => {
      today();
      spent = Math.max(spent, limit());
    },
  };
}

/** A fetch that counts each request against `budget`, and a 402 answer (the PRO plan's quota is gone) as the rest of the day. */
export function budgetedFetch(budget: DailyBudget, fetchFn: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    budget.spend();
    const res = await fetchFn(input, init);
    if (res.status === 402) budget.exhaust();
    return res;
  };
}

/** What the explorer-based findings say when the budget left the explorer out of an inspection. */
export const BUDGET_SPENT = "The explorer wasn't asked: this server has used up today's explorer reads for chains other than Arc.";

/** ...and when the server has no key for the explorer's PRO API (a dev server, CI), which is the only way it reads these chains. */
export const NO_EXPLORER_KEY = "The explorer wasn't asked: this server has no key for it.";
