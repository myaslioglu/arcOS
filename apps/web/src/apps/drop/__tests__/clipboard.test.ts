import { describe, expect, it } from "vitest";
import { unitsToNative } from "@arcos/chain";
import { failedRowsText } from "../clipboard";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

describe("failedRowsText", () => {
  it("round-trips a native-mode amount back to the 6-decimal units the user typed", () => {
    // The user typed "1.5"; the hook stores 6-decimal units and only converts to native wei at send
    // time, so the failure event's amount comes back as native wei — it must format back to "1.5".
    const text = failedRowsText([{ line: 2, address: A, amount: unitsToNative(1_500_000n) }], null, 6);
    expect(text).toBe(`${A},1.5`);
  });

  it("formats a token-mode amount with the token's own decimals", () => {
    const text = failedRowsText([{ line: 4, address: B, amount: 2_500_000_000_000_000_000n }], "0x3600000000000000000000000000000000000000", 18);
    expect(text).toBe(`${B},2.5`);
  });

  it("joins multiple rows with newlines, in the order given", () => {
    const text = failedRowsText(
      [
        { line: 2, address: A, amount: unitsToNative(1_000_000n) },
        { line: 7, address: B, amount: unitsToNative(250_000n) },
      ],
      null,
      6,
    );
    expect(text).toBe(`${A},1\n${B},0.25`);
  });

  it("returns an empty string for no failed rows", () => {
    expect(failedRowsText([], null, 6)).toBe("");
  });
});
