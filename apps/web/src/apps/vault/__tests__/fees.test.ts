import { describe, expect, it } from "vitest";
import { encodeAbiParameters, toFunctionSelector } from "viem";
import { V2_PAIR_CALLS, asPending, bpsText, flatFeeLine, isV2PairShape, lpFeeLine, raiseLine, shareFeeLine } from "../fees";

const word = encodeAbiParameters([{ type: "address" }], ["0x1111111111111111111111111111111111111111"]);
const reserves = encodeAbiParameters([{ type: "uint112" }, { type: "uint112" }, { type: "uint32" }], [1n, 2n, 3]);

describe("the Uniswap v2 pair shape, as VaultFactory._isV2Pair tells it", () => {
  it("calls token0(), token1() and getReserves()", () => {
    expect(V2_PAIR_CALLS).toEqual({
      token0: toFunctionSelector("token0()"),
      token1: toFunctionSelector("token1()"),
      getReserves: toFunctionSelector("getReserves()"),
    });
  });

  it("is a pair when all three succeed with exactly 32, 32 and 96 bytes", () => {
    expect(isV2PairShape(word, word, reserves)).toBe(true);
  });

  it("is not a pair when any call reverts, answers nothing, or answers another length", () => {
    expect(isV2PairShape(null, word, reserves)).toBe(false);
    expect(isV2PairShape(word, null, reserves)).toBe(false);
    expect(isV2PairShape(word, word, null)).toBe(false);
    expect(isV2PairShape(undefined, word, reserves)).toBe(false);
    expect(isV2PairShape("0x", word, reserves)).toBe(false);
    expect(isV2PairShape(`${word}00`, word, reserves)).toBe(false);
    // A getReserves() that answers 128 bytes (a fork with a fourth value) escapes the share, as in the contract.
    expect(isV2PairShape(word, word, `${reserves}${"00".repeat(32)}`)).toBe(false);
    expect(isV2PairShape(word, word, word)).toBe(false);
  });
});

describe("the fee lines", () => {
  it("writes basis points as a percentage", () => {
    expect(bpsText(50n)).toBe("0.5%");
    expect(bpsText(200n)).toBe("2%");
    expect(bpsText(1n)).toBe("0.01%");
    expect(bpsText(125n)).toBe("1.25%");
    expect(bpsText(0n)).toBe("0%");
  });

  it("states the flat fee, rounded up, sent with the lock", () => {
    expect(flatFeeLine(30n * 10n ** 18n)).toBe("Fee: 30 USDC per lock, sent with the lock transaction, plus gas.");
    expect(flatFeeLine(30n * 10n ** 18n + 1n)).toBe("Fee: 30.01 USDC per lock, sent with the lock transaction, plus gas.");
  });

  it("says what an LP lock's vault receives: the amount less the share, rounded down", () => {
    expect(lpFeeLine(50n, null, 18, "UNI-V2")).toBe("This is a Uniswap v2 LP token, so 0.5% of the amount goes to ArcOS and the vault receives the rest.");
    expect(lpFeeLine(50n, 100n * 10n ** 18n, 18, "UNI-V2")).toBe(
      "This is a Uniswap v2 LP token, so 0.5% of the amount goes to ArcOS: the vault receives 99.5 of your 100 UNI-V2.",
    );
    expect(lpFeeLine(50n, 9_999_999_999_999_999_999n, 18, "UNI-V2")).toBe(
      "This is a Uniswap v2 LP token, so 0.5% of the amount goes to ArcOS: the vault receives 9.95 of your 9.99 UNI-V2.",
    );
  });

  it("says a position's share comes out of collected fees only", () => {
    expect(shareFeeLine(200n)).toBe("ArcOS keeps 2% of the trading fees you collect from the vault. The position itself is not charged.");
  });
});

describe("a raise the FeeController has scheduled", () => {
  const NOW = 1_800_000_000;

  it("reads pendingOf: nothing is scheduled while effectiveAt is 0", () => {
    expect(asPending([100n, 1_800_172_800n])).toEqual({ value: 100n, effectiveAt: 1_800_172_800 });
    expect(asPending([0n, 0n])).toBeNull();
    expect(asPending(undefined)).toBeNull();
    expect(asPending(["1", 2n])).toBeNull();
  });

  it("warns on the form before the raise is due, with the time anyone may apply it from", () => {
    expect(raiseLine("lp", { value: 100n, effectiveAt: 1_802_584_639 }, 50n, NOW)).toBe(
      "ArcOS's share of an LP token lock can rise to 1% from 14 Feb 2027, 05:57 UTC.",
    );
    expect(raiseLine("share", { value: 500n, effectiveAt: 1_802_584_639 }, 200n, NOW)).toBe(
      "ArcOS's share of collected fees can rise to 5% from 14 Feb 2027, 05:57 UTC. A vault keeps the share it was made with.",
    );
    expect(raiseLine("flat", { value: 40n * 10n ** 18n, effectiveAt: 1_802_584_639 }, 30n * 10n ** 18n, NOW)).toBe(
      "The lock fee can rise to 40 USDC from 14 Feb 2027, 05:57 UTC.",
    );
  });

  it("says a raise that is due can land at any moment, before this lock is mined too, and that the lock then fails", () => {
    expect(raiseLine("lp", { value: 100n, effectiveAt: NOW }, 50n, NOW)).toBe(
      "ArcOS's share of an LP token lock can rise to 1% at any moment: the raise is due, and anyone can apply it. If it rises before this lock is mined, the lock fails and only gas is spent.",
    );
    expect(raiseLine("share", { value: 500n, effectiveAt: NOW - 1 }, 200n, NOW)).toBe(
      "ArcOS's share of collected fees can rise to 5% at any moment: the raise is due, and anyone can apply it. If it rises before this lock is mined, the lock fails and only gas is spent. A vault keeps the share it was made with.",
    );
    expect(raiseLine("flat", { value: 40n * 10n ** 18n, effectiveAt: NOW - 1 }, 30n * 10n ** 18n, NOW)).toBe(
      "The lock fee can rise to 40 USDC at any moment: the raise is due, and anyone can apply it. If it rises before this lock is mined, the lock fails and only gas is spent.",
    );
  });

  it("says nothing without a raise", () => {
    expect(raiseLine("lp", null, 50n, NOW)).toBeNull();
    expect(raiseLine("lp", { value: 50n, effectiveAt: NOW + 1 }, 50n, NOW)).toBeNull();
  });
});
