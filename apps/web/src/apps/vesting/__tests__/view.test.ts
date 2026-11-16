import { describe, expect, it } from "vitest";
import type { WalletView } from "../load";
import { amountText, nowFraction, phaseOf, phaseText, releaseState } from "../view";

const w: WalletView = {
  wallet: "0x1111111111111111111111111111111111111111",
  token: "0x2222222222222222222222222222222222222222",
  tokenInfo: { symbol: "TKN", decimals: 18 },
  start: 1_000n,
  duration: 1_000n,
  cliff: 400n,
  total: 1000n * 10n ** 18n,
  vested: 0n,
  released: 0n,
  releasable: 0n,
  source: "made",
};

describe("phase", () => {
  it("is locked until the cliff, vesting after it, done at the end", () => {
    expect(phaseOf(w, 500n)).toBe("locked");
    expect(phaseOf(w, 1_399n)).toBe("locked");
    expect(phaseOf(w, 1_400n)).toBe("vesting");
    expect(phaseOf(w, 1_999n)).toBe("vesting");
    expect(phaseOf(w, 2_000n)).toBe("done");
    expect(phaseText(w, 1_000n)).toMatch(/Nothing unlocks until 1 Jan 1970, 00:23 UTC/);
    expect(phaseText(w, 1_500n)).toMatch(/^Unlocking until/);
    expect(phaseText(w, 2_500n)).toMatch(/^Fully unlocked since/);
  });
});

describe("amountText", () => {
  it("rounds down, and says ? when it doesn't know", () => {
    expect(amountText(1_999_999_999_999_999_999n, { symbol: "TKN", decimals: 18 })).toBe("1.99 TKN");
    expect(amountText(null, { symbol: "TKN", decimals: 18 })).toBe("?");
    expect(amountText(5n, null)).toBe("?");
  });
});

describe("releaseState", () => {
  it("enables Release only when the wallet itself says something is releasable", () => {
    expect(releaseState({ ...w, releasable: 0n }, false)).toMatchObject({ enabled: false, reason: "Nothing can be released yet." });
    expect(releaseState({ ...w, releasable: 5n * 10n ** 18n }, false)).toEqual({ enabled: true, label: "Release 5 TKN", reason: null });
    expect(releaseState({ ...w, releasable: 5n }, true).enabled).toBe(false);
    expect(releaseState({ ...w, tokenInfo: null, releasable: null }, false).reason).toBe("Couldn't read this schedule's token. Try again.");
    expect(releaseState({ ...w, releasable: null }, false).reason).toMatch(/Couldn't read/);
  });
});

describe("nowFraction", () => {
  it("is null before the start, clamps at the end", () => {
    expect(nowFraction(1000n, 1000n, 999n)).toBeNull();
    expect(nowFraction(1000n, 1000n, 1500n)).toBe(0.5);
    expect(nowFraction(1000n, 1000n, 9999n)).toBe(1);
  });
});
