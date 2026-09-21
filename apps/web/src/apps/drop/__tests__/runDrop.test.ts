import { describe, expect, it, vi } from "vitest";
import type { Address } from "@arcos/chain";
import { UserFacingError } from "@/lib/contract-error";
import type { DropRow } from "../parse";
import { runDrop, type BatchOutcome, type DropDeps } from "../runDrop";

const addr = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;

function makeRows(n: number): DropRow[] {
  return Array.from({ length: n }, (_, i) => ({ line: i + 1, address: addr(i + 1), amount: BigInt((i + 1) * 100) }));
}

const success = (hash: string, failures: BatchOutcome["failures"] = []): BatchOutcome => ({ hash, status: "success", failures });
const reverted = (hash: string): BatchOutcome => ({ hash, status: "reverted", failures: [] });
const unconfirmed = (hash: string): BatchOutcome => ({ hash, status: "unconfirmed", failures: [] });

describe("runDrop", () => {
  it("delivers nothing from a reverted batch, stops, and puts every one of its rows in remaining", async () => {
    const rows = makeRows(3);
    const sendBatch = vi.fn<DropDeps["sendBatch"]>(async (_batch, n) => {
      if (n === 1) return reverted("0xhash1");
      throw new Error("must not be called after a revert");
    });
    const result = await runDrop(rows, 2, { sendBatch });

    expect(result.delivered).toEqual([]);
    expect(result.remaining).toEqual(rows);
    expect(result.failed).toEqual([]);
    expect(result.stoppedBecause).toBe("reverted");
    expect(result.message).toMatch(/reverted/i);
    expect(sendBatch).toHaveBeenCalledTimes(1);
  });

  it("does not throw when sendBatch rejects on batch 2 of 3; batch 1 stays delivered with its hash", async () => {
    const rows = makeRows(3);
    const err = Object.assign(new Error("User rejected the request"), {
      shortMessage: "User rejected the request",
      name: "UserRejectedRequestError",
    });
    const sendBatch = vi.fn<DropDeps["sendBatch"]>(async (_batch, n) => {
      if (n === 1) return success("0xhash1");
      if (n === 2) throw err;
      throw new Error("must not reach batch 3");
    });

    const result = await runDrop(rows, 1, { sendBatch });

    expect(result.delivered).toEqual([rows[0]]);
    expect(result.hashes).toEqual(["0xhash1"]);
    expect(result.remaining).toEqual([rows[1], rows[2]]);
    expect(result.stoppedBecause).toBe("rejected");
    expect(result.message).toBe("You cancelled the request in your wallet.");
    expect(sendBatch).toHaveBeenCalledTimes(2);
  });

  it("treats a non-rejection sendBatch failure as 'error', with a safe generic message — never the raw error text, which can carry RPC/transport detail", async () => {
    const rows = makeRows(2);
    const sendBatch = vi.fn<DropDeps["sendBatch"]>(async () => {
      throw new Error("execution reverted (unknown custom error) at https://rpc.internal.example");
    });

    const result = await runDrop(rows, 1, { sendBatch });

    expect(result.stoppedBecause).toBe("error");
    expect(result.message).toBe("The transaction didn't go through. Try again.");
    expect(result.message).not.toMatch(/https?:\/\//);
    expect(result.remaining).toEqual(rows);
    expect(result.delivered).toEqual([]);
  });

  it("passes a UserFacingError's message through verbatim — e.g. useDrop.ts's per-batch stale-fee stop condition", async () => {
    const rows = makeRows(2);
    const sendBatch = vi.fn<DropDeps["sendBatch"]>(async () => {
      throw new UserFacingError("The fee changed to 5 USDC. Check it and submit again.");
    });

    const result = await runDrop(rows, 1, { sendBatch });

    expect(result.stoppedBecause).toBe("error");
    expect(result.message).toBe("The fee changed to 5 USDC. Check it and submit again.");
    expect(result.remaining).toEqual(rows);
  });

  it("maps a decoded contract revert to its plain-language sentence via describeContractError", async () => {
    const rows = makeRows(1);
    const revertErr = {
      name: "ContractFunctionRevertedError",
      data: { errorName: "ZeroAmount", args: [0n] },
    };
    const sendBatch = vi.fn<DropDeps["sendBatch"]>(async () => {
      throw revertErr;
    });

    const result = await runDrop(rows, 1, { sendBatch });

    expect(result.stoppedBecause).toBe("error");
    expect(result.message).toBe("Row 1 has a zero amount.");
  });

  it("recognizes a UserRejectedRequestError nested anywhere in the cause chain", async () => {
    const inner = Object.assign(new Error("denied"), { name: "UserRejectedRequestError" });
    const outer = new Error("wrapped");
    (outer as Error & { cause?: unknown }).cause = inner;
    const rows = makeRows(1);
    const sendBatch = vi.fn<DropDeps["sendBatch"]>(async () => {
      throw outer;
    });

    const result = await runDrop(rows, 1, { sendBatch });
    expect(result.stoppedBecause).toBe("rejected");
  });

  it("recognizes EIP-1193 error code 4001 as a user rejection", async () => {
    const err = Object.assign(new Error("rejected"), { code: 4001 });
    const rows = makeRows(1);
    const sendBatch = vi.fn<DropDeps["sendBatch"]>(async () => {
      throw err;
    });

    const result = await runDrop(rows, 1, { sendBatch });
    expect(result.stoppedBecause).toBe("rejected");
  });

  it("maps per-row failures back to their CSV line numbers; everything else in the batch is delivered", async () => {
    const rows = makeRows(3);
    const sendBatch = vi.fn<DropDeps["sendBatch"]>(async () => success("0xhash", [{ index: 1, amount: rows[1].amount }]));

    const result = await runDrop(rows, 3, { sendBatch });

    expect(result.failed).toEqual([{ line: rows[1].line, address: rows[1].address, amount: rows[1].amount }]);
    expect(result.delivered).toEqual([rows[0], rows[2]]);
    expect(result.remaining).toEqual([]);
    expect(result.stoppedBecause).toBeNull();
    expect(result.message).toBeNull();
    expect(result.hashes).toEqual(["0xhash"]);
  });

  it("ignores an out-of-range failure index instead of crashing", async () => {
    const rows = makeRows(2);
    const sendBatch = vi.fn<DropDeps["sendBatch"]>(async () => success("0xhash", [{ index: 99, amount: 1n }]));

    const result = await runDrop(rows, 2, { sendBatch });

    expect(result.failed).toEqual([]);
    expect(result.delivered).toEqual(rows);
  });

  it("returns an all-empty result for an empty list without calling sendBatch", async () => {
    const sendBatch = vi.fn<DropDeps["sendBatch"]>(async () => success("0xhash"));
    const result = await runDrop([], 200, { sendBatch });

    expect(result).toEqual({ delivered: [], failed: [], remaining: [], unconfirmed: [], hashes: [], stoppedBecause: null, message: null });
    expect(sendBatch).not.toHaveBeenCalled();
  });

  // Fund-safety item from the wave E review: a batch whose transaction hash is known but whose
  // receipt could not be obtained (RPC timeout, dropped connection, ...) is neither delivered nor
  // safely re-sendable — it must never land back in `remaining` (that risks a double send) and the
  // run must stop instead of trying the next batch against an unknown wallet/chain state.
  describe("a batch reported as 'unconfirmed' (hash known, receipt couldn't be obtained)", () => {
    it("keeps its rows out of both delivered and remaining, stops the run, and records the hash", async () => {
      const rows = makeRows(3);
      const sendBatch = vi.fn<DropDeps["sendBatch"]>(async (_batch, n) => {
        if (n === 1) return success("0xhash1");
        if (n === 2) return unconfirmed("0xhash2");
        throw new Error("must not be called after an unconfirmed batch");
      });

      const result = await runDrop(rows, 1, { sendBatch });

      expect(result.delivered).toEqual([rows[0]]);
      expect(result.unconfirmed).toEqual([rows[1]]);
      // Batch 2's row must NOT reappear in remaining — that would invite resending it on top of a
      // send that may have already landed.
      expect(result.remaining).toEqual([rows[2]]);
      expect(result.hashes).toEqual(["0xhash1", "0xhash2"]);
      expect(result.stoppedBecause).toBe("unconfirmed");
      expect(result.message).toMatch(/unconfirmed/i);
      expect(result.message).toMatch(/explorer/i);
      expect(sendBatch).toHaveBeenCalledTimes(2);
    });

    it("puts every row of a multi-row unconfirmed batch in `unconfirmed`, not just the first", async () => {
      const rows = makeRows(4);
      const sendBatch = vi.fn<DropDeps["sendBatch"]>(async () => unconfirmed("0xhash"));

      const result = await runDrop(rows, 4, { sendBatch });

      expect(result.unconfirmed).toEqual(rows);
      expect(result.remaining).toEqual([]);
      expect(result.delivered).toEqual([]);
    });
  });
});
