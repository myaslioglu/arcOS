import { describe, expect, it } from "vitest";
import { BATCH, MAX_BATCH, chunk, parseDropList } from "../parse";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

describe("parseDropList", () => {
  it("reads comma, semicolon, tab and space separated rows, skipping a header and blanks", () => {
    const { rows, issues, total } = parseDropList(`address,amount\n${A},1.5\n\n${B};2\n`, 6);
    expect(issues).toEqual([]);
    expect(rows).toEqual([
      { line: 2, address: A, amount: 1_500_000n },
      { line: 4, address: B, amount: 2_000_000n },
    ]);
    expect(total).toBe(3_500_000n);
    expect(parseDropList(`${A}\t1\n${B} 2`, 0).rows).toHaveLength(2);
  });

  it("reports bad rows with their line numbers and keeps the good ones", () => {
    const { rows, issues } = parseDropList(`${A},1\nnot-an-address,1\n${B},abc\n${B},0\n${A},5\n${B}`, 6);
    expect(rows.map((r) => r.line)).toEqual([1]);
    expect(issues).toEqual([
      { line: 2, message: "Not an address" },
      { line: 3, message: '"abc" isn\'t a number' },
      { line: 4, message: "Amount is zero" },
      { line: 5, message: "Duplicate of line 1" },
      { line: 6, message: "Expected an address and an amount" },
    ]);
  });

  it("rejects more precision than the token has", () => {
    expect(parseDropList(`${A},0.1234567`, 6).issues).toEqual([{ line: 1, message: "At most 6 decimal places" }]);
  });

  it("refuses the zero address", () => {
    expect(parseDropList("0x0000000000000000000000000000000000000000,1", 6).issues[0]?.message).toBe("The zero address can't receive funds on Arc");
  });
});

describe("chunk", () => {
  it("splits into batches", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
  });
});

describe("BATCH", () => {
  it("never exceeds the contract's MAX_RECIPIENTS (mirrored here as MAX_BATCH)", () => {
    expect(BATCH).toBeLessThanOrEqual(MAX_BATCH);
  });
});
