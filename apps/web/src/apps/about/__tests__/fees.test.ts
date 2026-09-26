import { describe, expect, it } from "vitest";
import { feeSentence, readingsFrom } from "../fees";

/** USDC amount as the FeeController stores it: native 18-decimal wei. */
const usdc = (micro: bigint) => micro * 10n ** 12n;
const ok = (result: bigint) => ({ status: "success" as const, result });

describe("readingsFrom", () => {
  it("is loading until the reads come back", () => {
    expect(readingsFrom(undefined)).toBe("loading");
  });

  it("maps the six reads (fee and cap for Mint, Drop per recipient, Drop minimum), in that order", () => {
    const six = [1_000_000n, 50_000_000n, 50_000n, 500_000n, 2_000_000n, 10_000_000n].map((m) => ok(usdc(m)));
    expect(readingsFrom(six)).toEqual({
      mint: usdc(1_000_000n),
      mintCap: usdc(50_000_000n),
      perRecipient: usdc(50_000n),
      perRecipientCap: usdc(500_000n),
      dropMin: usdc(2_000_000n),
      dropMinCap: usdc(10_000_000n),
    });
  });

  it("is an error when any read failed or came back short", () => {
    const five = [1n, 2n, 3n, 4n, 5n].map(ok);
    expect(readingsFrom(five)).toBe("error");
    expect(readingsFrom([...five, { status: "failure" as const, error: new Error("rpc") }])).toBe("error");
  });
});

describe("feeSentence", () => {
  it("states the fees read from chain, with their caps", () => {
    const fees = {
      mint: usdc(1_000_000n),
      mintCap: usdc(50_000_000n),
      perRecipient: usdc(50_000n),
      perRecipientCap: usdc(500_000n),
      dropMin: usdc(2_000_000n),
      dropMinCap: usdc(10_000_000n),
    };
    expect(feeSentence(fees)).toBe(
      "Current fees: Mint 1 USDC flat (capped at 50 USDC). Drop 0.05 USDC per recipient, 2 USDC minimum (capped at 0.5 USDC per recipient, 10 USDC minimum).",
    );
  });

  it("never shows a number it hasn't read", () => {
    expect(feeSentence("loading")).not.toMatch(/\d/);
    expect(feeSentence("error")).not.toMatch(/\d/);
  });
});
