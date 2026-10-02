import { describe, expect, it } from "vitest";
import { ARC_GAS_RESERVE_UNITS, balanceLabel, maxAmountText, maxSpendable, overBalanceIssue } from "../balance";
import { bridgeFee } from "../appkit";
import { parseUsdc } from "@arcos/chain";

describe("maxSpendable", () => {
  it("is the whole balance with no reserve and no fee", () => {
    expect(maxSpendable(4_835_553n)).toBe(4_835_553n);
  });

  it("leaves the reserve behind, and is never negative", () => {
    expect(maxSpendable(4_835_553n, { reserveUnits: ARC_GAS_RESERVE_UNITS })).toBe(4_785_553n);
    expect(maxSpendable(ARC_GAS_RESERVE_UNITS, { reserveUnits: ARC_GAS_RESERVE_UNITS })).toBe(0n);
    expect(maxSpendable(10n, { reserveUnits: ARC_GAS_RESERVE_UNITS })).toBe(0n);
  });

  it("leaves room for a fee added on top: the amount plus Bridge's own fee on it still fits", () => {
    for (const balance of [1n, 999n, 1_000_000n, 4_785_553n, 123_456_789_012n]) {
      const max = maxSpendable(balance, { feeOnTopBps: 20 });
      // The fee Bridge actually charges: lib/appkit.ts's bridgeFee, floored to 6 decimals.
      const fee = parseUsdc(bridgeFee((Number(max) / 1e6).toFixed(6))) / 10n ** 12n;
      expect(max + fee, String(balance)).toBeLessThanOrEqual(balance);
    }
    expect(maxSpendable(4_785_553n, { feeOnTopBps: 20 })).toBe(4_776_000n);
  });
});

describe("maxAmountText", () => {
  it("writes the amount at the token's own decimals, without trailing zeros", () => {
    expect(maxAmountText(4_835_553n, 6, { reserveUnits: ARC_GAS_RESERVE_UNITS })).toBe("4.785553");
    expect(maxAmountText(150_000_000n, 8)).toBe("1.5");
  });

  it("is null when nothing can be spent", () => {
    expect(maxAmountText(0n, 6)).toBeNull();
    expect(maxAmountText(40_000n, 6, { reserveUnits: ARC_GAS_RESERVE_UNITS })).toBeNull();
  });
});

describe("balanceLabel", () => {
  it("reads 'Balance: X SYMBOL'", () => {
    expect(balanceLabel(4_835_553n, 6, "USDC")).toBe("Balance: 4.835553 USDC");
    expect(balanceLabel(0n, 8, "cirBTC")).toBe("Balance: 0 cirBTC");
  });
});

describe("overBalanceIssue", () => {
  it("says nothing while the balance is unknown, for an empty box, or for text that doesn't parse", () => {
    expect(overBalanceIssue("5", 6, undefined)).toBeNull();
    expect(overBalanceIssue("", 6, 0n)).toBeNull();
    expect(overBalanceIssue("abc", 6, 0n)).toBeNull();
  });

  it("allows up to the balance, and refuses more", () => {
    expect(overBalanceIssue("4.835553", 6, 4_835_553n)).toBeNull();
    expect(overBalanceIssue("4.835554", 6, 4_835_553n)).toBe("That's more than your balance.");
  });

  it("counts a fee on top, and names the chain", () => {
    expect(overBalanceIssue("4.776", 6, 4_785_553n, { feeOnTopBps: 20, where: "Arc" })).toBeNull();
    expect(overBalanceIssue("4.785553", 6, 4_785_553n, { feeOnTopBps: 20, where: "Arc" })).toBe("With the fee, that's more than your balance on Arc.");
    expect(overBalanceIssue("1", 6, 0n, { feeOnTopBps: 20, where: "Ethereum" })).toBe("With the fee, that's more than your balance on Ethereum.");
  });
});
