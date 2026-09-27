import { describe, expect, it } from "vitest";
import { reportMaxAge, reportTtlMs } from "../report-cache";

describe("how long a report stays fresh", () => {
  it("is 5 minutes for a clean report and 30 seconds for a degraded one", () => {
    expect([reportMaxAge({ degraded: false }), reportMaxAge({ degraded: true })]).toEqual([300, 30]);
  });

  it("gives the server's own cache the same ages, in milliseconds", () => {
    expect([reportTtlMs({ degraded: false }), reportTtlMs({ degraded: true })]).toEqual([300_000, 30_000]);
  });
});
