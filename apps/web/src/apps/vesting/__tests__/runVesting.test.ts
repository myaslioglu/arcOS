import { describe, expect, it, vi } from "vitest";
import type { DropRow } from "@/lib/recipient-list";
import { leftoverRows, runVesting, summarize, summaryText, type RowOutcome } from "../runVesting";

const row = (line: number): DropRow => ({ line, address: `0x${line.toString(16).padStart(40, "0")}`, amount: BigInt(line) * 100n });
const rows = [row(1), row(2), row(3)];
const vesting = (n: number) => `0x${"a".repeat(39)}${n}` as `0x${string}`;
const created = (n: number): RowOutcome => ({ status: "created", hash: `0x${n}`, vesting: vesting(n) });

describe("runVesting", () => {
  it("creates every row, in order, one at a time", async () => {
    const order: number[] = [];
    let inFlight = 0;
    const result = await runVesting(rows, {
      createRow: async (r, i) => {
        inFlight++;
        expect(inFlight).toBe(1);
        order.push(i);
        await Promise.resolve();
        inFlight--;
        return created(r.line);
      },
    });
    expect(order).toEqual([0, 1, 2]);
    expect(result.stoppedBecause).toBeNull();
    expect(result.states.map((s) => s.status)).toEqual(["created", "created", "created"]);
    expect(summaryText(3, summarize(result.states))).toBe("3 of 3 schedules created.");
  });

  it("records a failing row and goes on with the rest", async () => {
    const result = await runVesting(rows, {
      createRow: async (r): Promise<RowOutcome> => (r.line === 2 ? { status: "failed", message: "Your balance of this token is below this amount." } : created(r.line)),
    });
    expect(result.states.map((s) => s.status)).toEqual(["created", "failed", "created"]);
    expect(result.stoppedBecause).toBeNull();
    expect(summaryText(3, summarize(result.states))).toBe("2 of 3 schedules created. 1 failed.");
    expect(leftoverRows(rows, result.states).map((r) => r.line)).toEqual([2]);
  });

  it("stops at a refused signature: that row and the rest are not sent", async () => {
    const result = await runVesting(rows, {
      createRow: async (r) => {
        if (r.line === 2) throw Object.assign(new Error("denied"), { code: 4001 });
        return created(r.line);
      },
    });
    expect(result.stoppedBecause).toBe("rejected");
    expect(result.message).toBe("You cancelled the request in your wallet.");
    expect(result.states.map((s) => s.status)).toEqual(["created", "not_sent", "not_sent"]);
    expect(leftoverRows(rows, result.states).map((r) => r.line)).toEqual([2, 3]);
  });

  it("stops on any other thrown error and never shows its raw text", async () => {
    const result = await runVesting(rows, {
      createRow: async () => {
        throw new Error("https://secret.rpc/endpoint exploded");
      },
    });
    expect(result.stoppedBecause).toBe("error");
    expect(result.message).not.toMatch(/secret/);
    expect(result.states.every((s) => s.status === "not_sent")).toBe(true);
  });

  it("stops at an unconfirmed row, never retries it and keeps it out of the leftover rows", async () => {
    const calls: number[] = [];
    const result = await runVesting(rows, {
      createRow: async (r): Promise<RowOutcome> => {
        calls.push(r.line);
        return r.line === 2 ? { status: "unconfirmed", hash: "0xabc" } : created(r.line);
      },
    });
    expect(calls).toEqual([1, 2]);
    expect(result.stoppedBecause).toBe("unconfirmed");
    expect(result.states.map((s) => s.status)).toEqual(["created", "unconfirmed", "not_sent"]);
    expect(leftoverRows(rows, result.states).map((r) => r.line)).toEqual([3]);
    expect(summaryText(3, summarize(result.states))).toBe("1 of 3 schedules created. 1 not sent. 1 not confirmed.");
  });

  it("reports each state change as it happens", async () => {
    const onState = vi.fn();
    await runVesting([row(1)], { createRow: async () => created(1), onState });
    expect(onState.mock.calls.map((c) => (c[1] as { status: string }).status)).toEqual(["creating", "created"]);
  });

  it("does nothing for an empty list", async () => {
    const result = await runVesting([], { createRow: async () => created(1) });
    expect(result.states).toEqual([]);
  });
});

describe("summaryText", () => {
  it("says schedule for one", () => {
    expect(summaryText(1, { created: 1, failed: 0, notSent: 0, unconfirmed: 0 })).toBe("1 of 1 schedule created.");
  });
});
