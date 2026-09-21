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
