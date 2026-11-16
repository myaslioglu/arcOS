import { describe, expect, it } from "vitest";
import { vestFeeText, vestFeeTotal } from "../fee";

const TWENTY = 20n * 10n ** 18n;

describe("vestFeeTotal", () => {
  it("is the flat fee once per schedule", () => {
    expect(vestFeeTotal(TWENTY, 1)).toBe(TWENTY);
    expect(vestFeeTotal(TWENTY, 3)).toBe(60n * 10n ** 18n);
    expect(vestFeeTotal(TWENTY, 0)).toBe(0n);
    expect(vestFeeTotal(TWENTY, -2)).toBe(0n);
  });
});

describe("vestFeeText", () => {
  it("shows the total before signing", () => {
    expect(vestFeeText(TWENTY, 1)).toBe("Fee 20 USDC · paid in USDC with the transaction");
    expect(vestFeeText(TWENTY, 3)).toBe("Fee 60 USDC · 20 USDC for each of 3 schedules, charged as each one is created");
  });
  it("rounds up, so the fee is never understated", () => {
    expect(vestFeeText(20_001n * 10n ** 14n + 1n, 1)).toContain("2.01");
  });
  it("is empty with no rows or a failed read, and says so while reading", () => {
    expect(vestFeeText(TWENTY, 0)).toBe("");
    expect(vestFeeText("error", 2)).toBe("");
    expect(vestFeeText(null, 2)).toBe("Reading the fee…");
  });
});
