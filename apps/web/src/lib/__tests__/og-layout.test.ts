import { describe, expect, it } from "vitest";
import { OG_CONTENT_HEIGHT, OG_SLACK, findingRowBudget, ogStackHeight } from "../og-layout";

// The clipping fix (wave F) was a set of hand-tuned numbers with nothing holding them in place: a
// later line added to the card, or a row count raised back to 4, would overflow the fixed 630px
// box again, and satori answers overflow by shrinking every child until the header and the body
// overlap. These assertions are what makes that a failing test rather than a broken share image.

describe("findingRowBudget", () => {
  it("fits inside the card, with the explorer note and without", () => {
    for (const note of [true, false]) {
      const rows = findingRowBudget(note);
      expect([note, ogStackHeight(rows, note) <= OG_CONTENT_HEIGHT - OG_SLACK]).toEqual([note, true]);
    }
  });

  it("takes every row that does fit — one more would not", () => {
    for (const note of [true, false]) {
      const rows = findingRowBudget(note);
      expect([note, ogStackHeight(rows + 1, note) > OG_CONTENT_HEIGHT - OG_SLACK]).toEqual([note, true]);
    }
  });

  it("is the three rows the card is built around when the explorer note is shown, and four without it", () => {
    // Documented so a change to the layout has to be a deliberate change to this number too.
    expect([findingRowBudget(true), findingRowBudget(false)]).toEqual([3, 4]);
  });

  it("never gives up the rows entirely, however tight the box gets", () => {
    expect(findingRowBudget(true)).toBeGreaterThanOrEqual(1);
  });
});
