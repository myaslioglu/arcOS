import { describe, expect, it } from "vitest";
import { dropBatchFee, dropTotalFee, feeChangeMessage } from "../dropFee";

// Mirrors packages/contracts/src/Multisend.sol's quote(): recipients * DROP_PER_RECIPIENT, floored
// at DROP_MIN. Values below match the deployed R0 defaults (see script/DeployR0.s.sol) but the
// function itself takes them as arguments — it must work for any perRecipient/min pair.
const PER_RECIPIENT = 5n * 10n ** 16n; // 0.05 USDC, native wei
const MIN = 2n * 10n ** 18n; // 2 USDC, native wei

describe("dropBatchFee", () => {
  it("charges recipients * perRecipient once that's above the minimum", () => {
    // 200 * 0.05 = 10 USDC, above the 2 USDC minimum
    expect(dropBatchFee(PER_RECIPIENT, MIN, 200)).toBe(10n * 10n ** 18n);
  });

  it("floors at the minimum for a small batch", () => {
    // 10 * 0.05 = 0.5 USDC, below the 2 USDC minimum
    expect(dropBatchFee(PER_RECIPIENT, MIN, 10)).toBe(MIN);
  });

  it("charges exactly the minimum at the crossover point", () => {
    // 40 * 0.05 = 2 USDC, exactly the minimum
    expect(dropBatchFee(PER_RECIPIENT, MIN, 40)).toBe(MIN);
  });

  it("floors at the minimum for zero recipients", () => {
    // Only ever called with a real batch size in this app, but the formula itself has no special
    // case for 0 — it floors at the minimum like anything else below it.
    expect(dropBatchFee(PER_RECIPIENT, MIN, 0)).toBe(MIN);
  });
});

describe("dropTotalFee", () => {
  it("sums each batch's fee independently — the minimum applies per batch, not to the whole list", () => {
    // Two batches of 10: each alone would cost 0.5 USDC, floored to the 2 USDC minimum — so the
    // total is 4 USDC, not "20 recipients * 0.05 floored once to 2".
    expect(dropTotalFee(PER_RECIPIENT, MIN, [10, 10])).toBe(4n * 10n ** 18n);
  });

  it("matches summing dropBatchFee over the same sizes", () => {
    const sizes = [200, 200, 47];
    const expected = sizes.reduce((sum, n) => sum + dropBatchFee(PER_RECIPIENT, MIN, n), 0n);
    expect(dropTotalFee(PER_RECIPIENT, MIN, sizes)).toBe(expected);
  });

  it("is zero for an empty batch list", () => {
    expect(dropTotalFee(PER_RECIPIENT, MIN, [])).toBe(0n);
  });
});

describe("feeChangeMessage", () => {
  // Wave E "should fix": a mid-send fee-change stop used to quote the BATCH's fee total — a number
  // the user was never shown (the form only ever displays the whole-list total). This states the rate
  // that actually changed instead, in a unit the user did see on screen.
  it("reports the per-recipient rate that changed, in USDC, when that's what changed", () => {
    const previous = { perRecipient: PER_RECIPIENT, min: MIN };
    const fresh = { perRecipient: 8n * 10n ** 16n, min: MIN }; // 0.05 -> 0.08
    expect(feeChangeMessage(previous, fresh)).toBe("The fee per recipient changed from 0.05 to 0.08 USDC. Check it and submit again.");
  });

  it("reports the minimum that changed when the per-recipient rate is unchanged", () => {
    const previous = { perRecipient: PER_RECIPIENT, min: MIN };
    const fresh = { perRecipient: PER_RECIPIENT, min: 3n * 10n ** 18n }; // 2 -> 3
    expect(feeChangeMessage(previous, fresh)).toBe("The minimum fee changed from 2 to 3 USDC. Check it and submit again.");
  });

  it("prefers the per-recipient wording when both changed at once", () => {
    const previous = { perRecipient: PER_RECIPIENT, min: MIN };
    const fresh = { perRecipient: 1n * 10n ** 16n, min: 5n * 10n ** 18n };
    expect(feeChangeMessage(previous, fresh)).toMatch(/^The fee per recipient changed/);
  });
});
