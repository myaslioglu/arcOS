import { formatUsdc } from "@arcos/chain";

/** The two raw fee inputs a quote (or a batch's re-read) was computed from — DROP_PER_RECIPIENT and
 * DROP_MIN, both native wei. Declared here (not in useDrop.ts) so `feeChangeMessage` below doesn't
 * need to import from an app hook. */
export type DropFeeBasis = { perRecipient: bigint; min: bigint };

/**
 * Mirrors Multisend.sol's `quote(recipients)` exactly: `recipients * DROP_PER_RECIPIENT`, floored at
 * `DROP_MIN`. Kept as a pure function (rather than only ever reading `multisend.quote()` on chain) so
 * the "did the fee change since it was shown" check in useDrop.ts can compare a batch's fee against
 * two freshly-read numbers (`feeOf(DROP_PER_RECIPIENT)`, `feeOf(DROP_MIN)`) without a second RPC round
 * trip per batch, and so the formula itself is unit-tested against the contract's own logic.
 */
export function dropBatchFee(perRecipient: bigint, min: bigint, recipients: number): bigint {
  const fee = perRecipient * BigInt(recipients);
  return fee < min ? min : fee;
}

/** `dropBatchFee` summed over every batch a send will split into — the minimum applies PER BATCH,
 * not once across the whole list, exactly like separate `multisend.quote()` calls would. */
export function dropTotalFee(perRecipient: bigint, min: bigint, batchSizes: number[]): bigint {
  return batchSizes.reduce((sum, n) => sum + dropBatchFee(perRecipient, min, n), 0n);
}

/**
 * Describes a mid-send fee change in a rate the user actually saw. Before wave E's fix, the stop
 * condition in useDrop.ts quoted a BATCH's fee total — a number the form never displays (it only ever
 * shows the whole-list total) — which read as an arbitrary figure with no context. This instead names
 * whichever of the two underlying rates changed, in USDC, matching how the fee is actually quoted to
 * the user. Prefers the per-recipient wording when both changed at once, since that's the rate that
 * drives the total in the overwhelmingly common case (a large list, well above DROP_MIN).
 */
export function feeChangeMessage(previous: DropFeeBasis, fresh: DropFeeBasis): string {
  if (previous.perRecipient !== fresh.perRecipient) {
    return `The fee per recipient changed from ${formatUsdc(previous.perRecipient)} to ${formatUsdc(fresh.perRecipient)} USDC. Check it and submit again.`;
  }
  return `The minimum fee changed from ${formatUsdc(previous.min)} to ${formatUsdc(fresh.min)} USDC. Check it and submit again.`;
}
