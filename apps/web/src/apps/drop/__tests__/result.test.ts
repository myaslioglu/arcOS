import { describe, expect, it } from "vitest";
import type { DropRow } from "../parse";
import { failedRowsFor } from "../result";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";

const batch: DropRow[] = [
  { line: 5, address: A, amount: 1n },
  { line: 9, address: B, amount: 2n },
  { line: 12, address: C, amount: 3n },
];

describe("failedRowsFor", () => {
  it("maps a TransferFailed log's batch-local index back to the row's original CSV line", () => {
    const failures = [{ args: { index: 1n, recipient: B, amount: 2n } }];
    expect(failedRowsFor(batch, failures)).toEqual([{ line: 9, address: B, amount: 2n }]);
  });

  it("ignores an index outside the batch instead of crashing", () => {
    const failures = [{ args: { index: 99n, recipient: A, amount: 1n } }];
    expect(failedRowsFor(batch, failures)).toEqual([]);
  });

  it("preserves the order of the decoded logs across multiple failures", () => {
    const failures = [
      { args: { index: 2n, recipient: C, amount: 3n } },
      { args: { index: 0n, recipient: A, amount: 1n } },
    ];
    expect(failedRowsFor(batch, failures)).toEqual([
      { line: 12, address: C, amount: 3n },
      { line: 5, address: A, amount: 1n },
    ]);
  });

  it("returns an empty list for an empty batch or no failures", () => {
    expect(failedRowsFor([], [])).toEqual([]);
    expect(failedRowsFor(batch, [])).toEqual([]);
  });
});
