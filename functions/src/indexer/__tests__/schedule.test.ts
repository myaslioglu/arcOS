import { describe, expect, it } from "vitest";
import { INDEXER_OPTIONS, indexerSettings } from "../schedule";

describe("INDEXER_OPTIONS", () => {
  it("is design 1.3's: every minute, UTC, europe-west4, one instance, one request, no retry, 512 MiB, 120 s, as arcos-jobs@", () => {
    expect(INDEXER_OPTIONS).toEqual({
      schedule: "every 1 minutes",
      timeZone: "Etc/UTC",
      region: "europe-west4",
      retryCount: 0,
      maxInstances: 1,
      concurrency: 1,
      memory: "512MiB",
      timeoutSeconds: 120,
      serviceAccount: "arcos-jobs@arcos-c80cf.iam.gserviceaccount.com",
    });
  });
});

describe("indexerSettings", () => {
  it("defaults to 3 inspections a run and 5,000 explorer calls a day", () => {
    expect(indexerSettings({})).toEqual({ inspectPerTick: 3, explorerDailyBudget: 5_000 });
  });

  it("takes whole numbers from the environment, and ignores anything else", () => {
    expect(indexerSettings({ INSPECT_PER_TICK: " 5 ", EXPLORER_DAILY_BUDGET: "0" })).toEqual({ inspectPerTick: 5, explorerDailyBudget: 0 });
    for (const bad of ["", "-1", "1.5", "1e3", "abc", "99999999"]) {
      expect(indexerSettings({ INSPECT_PER_TICK: bad, EXPLORER_DAILY_BUDGET: bad })).toEqual({ inspectPerTick: 3, explorerDailyBudget: 5_000 });
    }
  });
});
