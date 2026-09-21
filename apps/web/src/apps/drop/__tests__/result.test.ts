import { describe, expect, it } from "vitest";
import type { DropRow } from "../parse";
import { excludedRowsText, failedRowsFor, unconfirmedHash, type ExcludedRow } from "../result";

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

const excludedRow = (line: number, text: string, reason: string): ExcludedRow => ({ line, text, reason });

describe("excludedRowsText", () => {
  it("returns null when nothing was excluded, so a result reads as covering everything", () => {
    expect(excludedRowsText([])).toBeNull();
  });

  it("states the count and the exact lines for multiple excluded rows", () => {
    const rows = [excludedRow(4, "not-an-address, 1", "Not an address"), excludedRow(9, "0x1,0", "Amount is zero"), excludedRow(17, "", "Expected an address and an amount")];
    expect(excludedRowsText(rows)).toBe("3 rows weren't sent because they had problems: lines 4, 9, 17");
  });

  it("uses singular wording for exactly one excluded row", () => {
    expect(excludedRowsText([excludedRow(6, "0x1,0", "Amount is zero")])).toBe("1 row wasn't sent because it had a problem: line 6");
  });

  it("preserves the given row order rather than re-sorting", () => {
    const rows = [excludedRow(9, "a", "x"), excludedRow(4, "b", "y"), excludedRow(17, "c", "z")];
    expect(excludedRowsText(rows)).toBe("3 rows weren't sent because they had problems: lines 9, 4, 17");
  });
});

describe("excludedRowsText keeps each row's original text and reason available (wave E should-fix)", () => {
  // Before this fix, only the line NUMBER was kept — after a partial send replaced the textarea with
  // just the remainder, "lines 4, 9, 17" pointed at text the user could no longer see anywhere. The
  // caller (ResultPanel.tsx) renders `text`/`reason` directly so nothing typed silently disappears.
  it("preserves the exact original line text (not re-derived from the row's address/amount)", () => {
    const rows = [excludedRow(4, "  0xnotaddr , 12.5  ", "Not an address")];
    expect(rows[0].text).toBe("  0xnotaddr , 12.5  ");
    expect(rows[0].reason).toBe("Not an address");
  });
});

describe("unconfirmedHash (N1 — which hash belongs to the unconfirmed batch)", () => {
  // runDrop.ts pushes an unconfirmed batch's hash right before returning (see its own doc comment
  // on BatchOutcome/"unconfirmed"), so it is always the LAST entry in `hashes` whenever the run
  // stopped that way. This makes that otherwise-implicit ordering an explicit, tested fact instead
  // of something ResultPanel.tsx has to assume on its own.
  it("is null when the run didn't stop unconfirmed", () => {
    expect(unconfirmedHash({ hashes: ["0x1", "0x2"], stoppedBecause: null })).toBeNull();
    expect(unconfirmedHash({ hashes: ["0x1"], stoppedBecause: "reverted" })).toBeNull();
    expect(unconfirmedHash({ hashes: [], stoppedBecause: "rejected" })).toBeNull();
    expect(unconfirmedHash({ hashes: ["0x1"], stoppedBecause: "error" })).toBeNull();
  });

  it("is the LAST hash recorded when the run stopped unconfirmed — the earlier, already-delivered batches' hashes are not it", () => {
    expect(unconfirmedHash({ hashes: ["0x1", "0x2", "0x3"], stoppedBecause: "unconfirmed" })).toBe("0x3");
  });

  it("is the only hash when the very first batch was the one that came back unconfirmed", () => {
    expect(unconfirmedHash({ hashes: ["0xonly"], stoppedBecause: "unconfirmed" })).toBe("0xonly");
  });

  it("is null (never crashes) if somehow stopped unconfirmed with no hash recorded at all", () => {
    expect(unconfirmedHash({ hashes: [], stoppedBecause: "unconfirmed" })).toBeNull();
  });
});
