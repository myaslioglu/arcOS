import { describe, expect, it } from "vitest";
import { runLogFields, type RunResult } from "../run";

// What index.ts logs of a run's result: everything but Watchdog's cursor, a watchState doc id that names a token.

const ran: Extract<RunResult, { status: "ran" }> = {
  status: "ran",
  head: 1_000_010,
  from: 1_000_000,
  to: 1_000_010,
  windows: 1,
  pools: 0,
  tokens: 0,
  requeued: 0,
  inspected: 0,
  failed: 0,
  expired: 0,
  feeds: 0,
  explorerCalls: 0,
  watch: { checked: 1, unread: 0, failed: 0, alerts: 1, writes: 1, deliveriesCreated: 1, fannedOut: 1, sent: 1, sendFailed: 0, skipped: null, cursor: "mainnet:0x8f3a00000000000000000000000000000000913c" },
  error: null,
};

describe("runLogFields", () => {
  it("keeps every counter of a run and leaves out Watchdog's cursor", () => {
    const fields = runLogFields(ran);
    expect(fields).toEqual({ ...ran, watch: { checked: 1, unread: 0, failed: 0, alerts: 1, writes: 1, deliveriesCreated: 1, fannedOut: 1, sent: 1, sendFailed: 0, skipped: null } });
    expect(fields.watch).not.toHaveProperty("cursor");
    expect(JSON.stringify(fields)).not.toMatch(/0x/i);
    // The result itself still carries it: finishRun writes it, and the emulator tests read it.
    expect(ran.watch?.cursor).toMatch(/^mainnet:0x/);
  });

  it("passes the other results through as they are", () => {
    expect(runLogFields({ ...ran, watch: null })).toEqual({ ...ran, watch: null });
    expect(runLogFields({ status: "halted", reason: "eth_getLogs refused the single block 7" })).toEqual({ status: "halted", reason: "eth_getLogs refused the single block 7" });
    expect(runLogFields({ status: "busy", until: 1 })).toEqual({ status: "busy", until: 1 });
    expect(runLogFields({ status: "paused" })).toEqual({ status: "paused" });
  });
});
