import { describe, expect, it, vi } from "vitest";
import { parseAbi } from "viem";
import { READ_BUDGET, ok, readEach, type ContractRead, type Read, type ReadResult } from "../reads";

const abi = parseAbi(["function symbol() view returns (string)"]);
const call = (i: number): ContractRead => ({ address: `0x${i.toString(16).padStart(40, "0")}`, abi, functionName: "symbol" });
const success = (result: unknown): ReadResult => ({ status: "success", result });

/** A batch reader whose batches fail whenever they hold one of `poison`, as an eth_call does when one call in it burns all the gas. */
function reader(poison: Set<number>) {
  const batches: number[][] = [];
  const read: Read = async (calls) => {
    const ids = calls.map((c) => parseInt(c.address.slice(2), 16));
    batches.push(ids);
    if (ids.some((id) => poison.has(id))) throw new Error("out of gas");
    return ids.map((id) => success(`T${id}`));
  };
  return { read, batches };
}

describe("ok", () => {
  it("is a success's result and undefined otherwise", () => {
    expect(ok(success(3n))).toBe(3n);
    expect(ok({ status: "failure", error: new Error("x") })).toBeUndefined();
    expect(ok(undefined)).toBeUndefined();
  });
});

describe("readEach", () => {
  it("reads a clean list in one batch", async () => {
    const { read, batches } = reader(new Set());
    const results = await readEach(read, [1, 2, 3, 4].map(call));
    expect(results.map(ok)).toEqual(["T1", "T2", "T3", "T4"]);
    expect(batches).toHaveLength(1);
  });

  it("isolates a call that takes its whole batch down, and answers every other one", async () => {
    const { read, batches } = reader(new Set([3]));
    const results = await readEach(read, [1, 2, 3, 4, 5, 6, 7, 8].map(call));
    expect(results.map(ok)).toEqual(["T1", "T2", undefined, "T4", "T5", "T6", "T7", "T8"]);
    expect(results[2]?.status).toBe("failure");
    expect(batches.length).toBeLessThanOrEqual(READ_BUDGET);
  });

  it("stops at its budget, and counts what is left as failed", async () => {
    const { read, batches } = reader(new Set([1, 2, 3, 4, 5, 6, 7, 8]));
    const results = await readEach(read, [1, 2, 3, 4, 5, 6, 7, 8].map(call), 4);
    expect(batches).toHaveLength(4);
    expect(results.every((r) => r.status === "failure")).toBe(true);
  });

  it("sends nothing for nothing", async () => {
    const read = vi.fn<Read>();
    expect(await readEach(read, [])).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });
});
