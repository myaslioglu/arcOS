import { describe, expect, it } from "vitest";
import * as drop from "../../apps/drop/parse";
import * as shared from "../recipient-list";

// Drop and Vesting read the same `address,amount` lists, so the parser lives here and each app imports it (apps never
// import each other). Drop's own parse tests (apps/drop/__tests__/parse.test.ts) hold its behaviour.
describe("the shared recipient list", () => {
  it("is the very parser Drop uses", () => {
    expect(drop.parseDropList).toBe(shared.parseDropList);
    expect(drop.hasAmbiguousIssue).toBe(shared.hasAmbiguousIssue);
    expect(drop.ambiguousBannerText).toBe(shared.ambiguousBannerText);
    expect(drop.MAX_ROWS).toBe(shared.MAX_ROWS);
  });

  it("reads rows with a header, and leaves out a duplicate", () => {
    const a = "0x1111111111111111111111111111111111111111";
    const { rows, issues, total } = shared.parseDropList(`address,amount\n${a},1.5\n${a},2`, 6);
    expect(rows).toEqual([{ line: 2, address: a, amount: 1_500_000n }]);
    expect(issues).toEqual([{ line: 3, message: "Duplicate of line 2" }]);
    expect(total).toBe(1_500_000n);
  });
});
