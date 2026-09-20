import { describe, expect, it } from "vitest";
import { BATCH, MAX_BATCH, batchSizes, chunk, formatDropList, parseDropList } from "../parse";

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

  it("flags a duplicate address regardless of checksum casing", () => {
    const upper = "0xABCDEF1234567890ABCDEF1234567890ABCDEF12";
    const lower = upper.toLowerCase();
    const { rows, issues } = parseDropList(`${upper},1\n${lower},2`, 6);
    expect(rows.map((r) => r.line)).toEqual([1]);
    expect(issues).toEqual([{ line: 2, message: "Duplicate of line 1" }]);
  });
});

describe("thousands separators", () => {
  it("keeps a comma-grouped amount intact after a comma-separated address", () => {
    const { rows, issues } = parseDropList(`${A},1,000.50`, 6);
    expect(issues).toEqual([]);
    expect(rows).toEqual([{ line: 1, address: A, amount: 1_000_500_000n }]);
  });

  it("keeps a comma-grouped amount intact after a semicolon separator", () => {
    const { rows, issues } = parseDropList(`${A};2,500`, 0);
    expect(issues).toEqual([]);
    expect(rows[0]?.amount).toBe(2500n);
  });

  it("keeps a comma-grouped amount intact after a tab separator", () => {
    const { rows, issues } = parseDropList(`${A}\t1,000,000`, 0);
    expect(issues).toEqual([]);
    expect(rows[0]?.amount).toBe(1_000_000n);
  });

  it("rejects a malformed grouping with the amount parser's own message", () => {
    const { rows, issues } = parseDropList(`${A},1,5`, 6);
    expect(rows).toEqual([]);
    expect(issues).toEqual([{ line: 1, message: '"1,5" isn\'t a number' }]);
  });

  it("trims whitespace around the amount left after the separator run", () => {
    const { rows, issues } = parseDropList(`${A}, 12.5 `, 6);
    expect(issues).toEqual([]);
    expect(rows[0]?.amount).toBe(12_500_000n);
  });

  it("rejects a space inside the amount itself", () => {
    const { rows, issues } = parseDropList(`${A},1 000`, 6);
    expect(rows).toEqual([]);
    expect(issues).toEqual([{ line: 1, message: '"1 000" isn\'t a number' }]);
  });
});

describe("header detection", () => {
  it("treats line 1 as a header only when its first cell is letters, spaces or underscores", () => {
    expect(parseDropList(`address,amount\n${A},1`, 6).rows).toHaveLength(1);
    expect(parseDropList(`wallet_address,amount\n${A},1`, 6).rows).toHaveLength(1);
    expect(parseDropList(`Recipient Amount\n${A},1`, 6).rows).toHaveLength(1);
  });

  it("never drops a genuine typo on line 1 as if it were a header", () => {
    const { rows, issues } = parseDropList("0x123,5", 6);
    expect(rows).toEqual([]);
    expect(issues).toEqual([{ line: 1, message: "Not an address" }]);
  });

  it("never treats a non-0x typo on line 1 as a header just because it lacks the prefix", () => {
    const { rows, issues } = parseDropList("123abc,5", 6);
    expect(rows).toEqual([]);
    expect(issues).toEqual([{ line: 1, message: "Not an address" }]);
  });
});

describe("size guard", () => {
  it("refuses more than 10,000 rows outright, without parsing any of them", () => {
    const text = Array.from({ length: 10_001 }, () => `${A},1`).join("\n");
    const { rows, issues } = parseDropList(text, 6);
    expect(rows).toEqual([]);
    expect(issues).toEqual([{ line: 0, message: "A list can have at most 10,000 rows" }]);
  });

  it("still parses exactly 10,000 rows", () => {
    const text = Array.from({ length: 10_000 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")},1`).join("\n");
    const { rows, issues } = parseDropList(text, 6);
    expect(issues).toEqual([]);
    expect(rows).toHaveLength(10_000);
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

describe("batchSizes", () => {
  it("computes the size of each batch arithmetically, matching chunk(...).map(b => b.length)", () => {
    expect(batchSizes(0, 200)).toEqual([]);
    expect(batchSizes(200, 200)).toEqual([200]);
    expect(batchSizes(201, 200)).toEqual([200, 1]);
    expect(batchSizes(450, 200)).toEqual([200, 200, 50]);
  });

  it("agrees with chunk for an arbitrary count", () => {
    const items = Array.from({ length: 733 }, (_, i) => i);
    expect(batchSizes(items.length, 200)).toEqual(chunk(items, 200).map((b) => b.length));
  });
});

describe("formatDropList", () => {
  it("round-trips a native-USDC amount exactly, with no thousands separators", () => {
    for (const amount of ["12.5", "0.000001", "1000"]) {
      const { rows, issues } = parseDropList(`${A},${amount}`, 6);
      expect(issues).toEqual([]);
      expect(formatDropList(rows, null, 6)).toBe(`${A},${amount}`);
    }
  });

  it("formats a token-mode amount with the token's own decimals", () => {
    const { rows } = parseDropList(`${A},2.5`, 18);
    expect(formatDropList(rows, "0x3600000000000000000000000000000000000000", 18)).toBe(`${A},2.5`);
  });

  it("round-trips a whole number for a 0-decimal token (5 <-> 5n, no decimal point introduced)", () => {
    const { rows, issues } = parseDropList(`${A},5`, 0);
    expect(issues).toEqual([]);
    expect(rows).toEqual([{ line: 1, address: A, amount: 5n }]);
    expect(formatDropList(rows, "0x3600000000000000000000000000000000000000", 0)).toBe(`${A},5`);
  });

  it("joins multiple rows with newlines, in the given order", () => {
    const { rows } = parseDropList(`${A},1\n${B},0.25`, 6);
    expect(formatDropList(rows, null, 6)).toBe(`${A},1\n${B},0.25`);
  });

  it("returns an empty string for no rows", () => {
    expect(formatDropList([], null, 6)).toBe("");
  });
});
