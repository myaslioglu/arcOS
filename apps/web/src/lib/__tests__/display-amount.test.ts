import { describe, expect, it } from "vitest";
import { DUST_FLOOR, displayAmount, displayUnits, displayWei } from "../display-amount";

describe("displayAmount", () => {
  it("shows at most 2 decimals from 1 up, with separators", () => {
    expect(displayAmount("2496.490622")).toBe("2,496.49");
    expect(displayAmount("1234567.891")).toBe("1,234,567.89");
    expect(displayAmount("12.5")).toBe("12.5");
    expect(displayAmount("12.50")).toBe("12.5");
    expect(displayAmount("1")).toBe("1");
    expect(displayAmount("999.999")).toBe("1,000");
    expect(displayAmount("1.005")).toBe("1.01");
  });
  it("can leave the separators off", () => {
    expect(displayAmount("2496.49", { separators: false })).toBe("2496.49");
  });
  it("keeps 4 significant digits below 1", () => {
    expect(displayAmount("0.003725534907829057")).toBe("0.003726");
    expect(displayAmount("0.5")).toBe("0.5");
    expect(displayAmount("0.123456")).toBe("0.1235");
    expect(displayAmount("0.0001")).toBe("0.0001");
    expect(displayAmount("0.000123456")).toBe("0.0001235");
  });
  it("carries into 1 and into the next digit", () => {
    expect(displayAmount("0.99996")).toBe("1");
    expect(displayAmount("0.09999999")).toBe("0.1");
  });
  it("floors dust at < 0.0001 and never shows a fee as 0", () => {
    expect(displayAmount("0.00009999")).toBe(DUST_FLOOR);
    expect(displayAmount("0.000001")).toBe("< 0.0001");
    expect(displayAmount("0.000000000000000001")).toBe("< 0.0001");
  });
  it("shows zero as 0", () => {
    expect(displayAmount("0")).toBe("0");
    expect(displayAmount("0.000000")).toBe("0");
  });
  it("hands back text that is not a plain decimal", () => {
    expect(displayAmount("unknown")).toBe("unknown");
    expect(displayAmount("")).toBe("");
    expect(displayAmount("-1.234")).toBe("-1.234");
  });
});

describe("displayUnits and displayWei", () => {
  it("formats token units at their own decimals", () => {
    expect(displayUnits(2_496_490_622n, 6)).toBe("2,496.49");
    expect(displayUnits(1n, 8)).toBe(DUST_FLOOR);
    expect(displayUnits(150_000n, 8)).toBe("0.0015");
  });
  it("formats native wei as USDC", () => {
    expect(displayWei(2_496_490_622_000_000_000_000n)).toBe("2,496.49");
    expect(displayWei(3_725_534_907_829_057n)).toBe("0.003726");
    expect(displayWei(1_000_000_000_000n)).toBe(DUST_FLOOR);
    expect(displayWei(5n)).toBe(DUST_FLOOR);
    expect(displayWei(0n)).toBe("0");
  });
});

describe("rounding modes", () => {
  it("rounds down for what the user receives", () => {
    expect(displayAmount("222.885292", { mode: "down" })).toBe("222.88");
    expect(displayAmount("999.999", { mode: "down" })).toBe("999.99");
    expect(displayAmount("0.99996", { mode: "down" })).toBe("0.9999");
    expect(displayAmount("0.003725534907", { mode: "down" })).toBe("0.003725");
    expect(displayAmount("5", { mode: "down" })).toBe("5");
  });
  it("rounds up for what the user pays", () => {
    expect(displayAmount("1.234", { mode: "up" })).toBe("1.24");
    expect(displayAmount("0.99996", { mode: "up" })).toBe("1");
    expect(displayAmount("999.991", { mode: "up" })).toBe("1,000");
    expect(displayAmount("0.003725534907", { mode: "up" })).toBe("0.003726");
    expect(displayAmount("1.5", { mode: "up" })).toBe("1.5");
  });
  it("keeps the dust floor in every mode", () => {
    for (const mode of ["down", "up", "half"] as const) expect(displayAmount("0.00001", { mode })).toBe(DUST_FLOOR);
  });
  it("passes the mode through units and wei", () => {
    expect(displayUnits(222_885_292n, 6, "down")).toBe("222.88");
    expect(displayUnits(222_885_292n, 6, "up")).toBe("222.89");
    expect(displayWei(1_234_000_000_000_000_000n, "up")).toBe("1.24");
    expect(displayWei(1_234_000_000_000_000_000n, "down")).toBe("1.23");
  });
});
