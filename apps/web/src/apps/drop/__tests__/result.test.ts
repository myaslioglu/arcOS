import { describe, expect, it } from "vitest";
import type { DropRow } from "../parse";
import { excludedRowsText, failedRowsFor, remainingBannerText, unconfirmedHash, type ExcludedRow } from "../result";

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

describe("remainingBannerText (N2 — the banner must not undercount after an unconfirmed batch)", () => {
  it("is null when nothing is unsent at all", () => {
    expect(remainingBannerText({ remaining: [], unconfirmed: [], stoppedBecause: null })).toBeNull();
  });

  it("names only `remaining` for an ordinary partial send (reverted/rejected/error) — unchanged wording", () => {
    const rows: DropRow[] = [{ line: 1, address: A, amount: 1n }, { line: 2, address: B, amount: 1n }];
    expect(remainingBannerText({ remaining: rows, unconfirmed: [], stoppedBecause: "reverted" })).toBe(
      "2 rows weren't sent. They're in the list below — check and send again.",
    );
  });

  // The exact hazard N2 fixes: after an unconfirmed batch, `remaining` only counts rows from
  // batches never even attempted — it does NOT include the unconfirmed batch's own rows (see
  // runDrop.ts) — so a banner naming only `remaining.length` silently undercounts and reads as if
  // it covers the whole story.
  it("names BOTH counts once the run stopped because a batch came back unconfirmed", () => {
    const unconfirmedRows: DropRow[] = Array.from({ length: 400 }, (_, i) => ({ line: i + 1, address: A, amount: 1n }));
    const remainingRows: DropRow[] = Array.from({ length: 400 }, (_, i) => ({ line: i + 401, address: B, amount: 1n }));
    expect(remainingBannerText({ remaining: remainingRows, unconfirmed: unconfirmedRows, stoppedBecause: "unconfirmed" })).toBe(
      "400 rows are unconfirmed — see below. 400 rows weren't sent and are in the list.",
    );
  });

  it("names only the unconfirmed count when every OTHER batch had already been attempted (nothing left in remaining)", () => {
    const unconfirmedRows: DropRow[] = [{ line: 1, address: A, amount: 1n }];
    expect(remainingBannerText({ remaining: [], unconfirmed: unconfirmedRows, stoppedBecause: "unconfirmed" })).toBe(
      "1 rows are unconfirmed — see below.",
    );
  });

  it("falls back to the ordinary wording if stoppedBecause says unconfirmed but there are somehow no unconfirmed rows", () => {
    const rows: DropRow[] = [{ line: 1, address: A, amount: 1n }];
    expect(remainingBannerText({ remaining: rows, unconfirmed: [], stoppedBecause: "unconfirmed" })).toBe(
      "1 rows weren't sent. They're in the list below — check and send again.",
    );
  });
});
